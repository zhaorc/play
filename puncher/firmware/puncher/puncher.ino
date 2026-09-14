/* ============================================================
 * 打孔机固件 puncher.ino
 * 完美钢琴纸带打孔机 · Arduino Nano (ATmega328P)
 *
 * 硬件（依据 打孔机.md / 打孔机-设计方案.md）：
 *   X 轴：NEMA 17HS2408 + THB6128（128 细分），直连 Φ24mm 滚轮摩擦走带
 *         25600 脉冲/圈 → π×24 = 75.40mm/圈 → 339.53 脉冲/mm
 *   Y 轴：同款电机驱动，1模21齿齿轮 + 齿条，节圆 Φ21mm
 *         25600 脉冲/圈 → π×21 = 65.97mm/圈 → 388.02 脉冲/mm
 *   Z 轴：PWM 舵机（50Hz，独立 5V 供电），90° 抬起 / 45° 下压，钻孔 2s
 *   通信：USB 串口 115200，ASCII 行协议（\n 结尾）
 *
 * 坐标约定：机器 X = 纸带长度方向（走带），机器 Y = 纸带宽度方向
 *           固件映射：机器 (x, y) = (holeYMM, laneXMM)
 *
 * 接线（D2..D7 全在 PORTD，脉冲用端口直写保证速度）：
 *   X: PUL=D2  DIR=D3  ENA=D4（低有效=使能）
 *   Y: PUL=D5  DIR=D6  ENA=D7（低有效=使能）
 *   Z 舵机信号 = D9（舵机电源必须外接 5V，勿用 Nano USB 供电）
 *   预留：X 限位=D8  Y 限位=A1  硬件急停按钮=A0（均 INPUT_PULLUP，
 *         常开接地触发；不安装时悬空不影响使用）
 *
 * 串口协议（应答 OK / DONE / ERR <原因>，DONE 表示单孔/点动完成）：
 *   V                版本握手，回 "PUNCHER v1.0 READY"
 *   O                当前位置设为原点（手动对刀后）；急停后须先 O 才能恢复运动
 *   J <x> <y>        点动到绝对毫米坐标（不打孔），到位回 DONE
 *   P <x> <y>        在绝对坐标打一个孔（X→Y→下钻2s→抬钻），回 DONE
 *   Z0 / Z1          手动抬钻(90°) / 压钻(45°)，调试用
 *   F <mm/s>         进给速度 1~50（默认 10，掉电不保存）
 *   C <xpmm> <ypmm>  校准脉冲当量，写 EEPROM 永久保存
 *   Q                查询位置，回 "POS <xmm> <ymm>"
 *   R                急停：立即停脉冲、抬钻，回 "OK ESTOP"
 * ============================================================ */

#include <Servo.h>
#include <EEPROM.h>

// ---------------- 固件版本 ----------------
#define FW_NAME    "PUNCHER"
#define FW_VER     "v1.0"

// ---------------- 引脚 ----------------
#define X_PUL      2   // PD2
#define X_DIR      3   // PD3
#define X_ENA      4   // PD4
#define Y_PUL      5   // PD5
#define Y_DIR      6   // PD6
#define Y_ENA      7   // PD7
#define X_LIM      8   // 预留：X 限位/原点开关
#define Z_SERVO    9   // 舵机信号（硬件 PWM）
#define ESTOP_BTN  A0  // 预留：硬件急停按钮
#define Y_LIM      A1  // 预留：Y 限位/原点开关

// ---------------- 机械常量 ----------------
#define STEPS_PER_REV   200
#define MICROSTEPS      128
#define PULSES_PER_REV  ((int32_t)STEPS_PER_REV * MICROSTEPS)   // 25600
#define X_ROLLER_DIA_MM 24.0f     // X 滚轮直径
#define Y_PITCH_DIA_MM  21.0f     // Y 齿轮节圆直径（1模×21齿）
// 理论脉冲当量：X = 25600/(π×24) = 339.53 /mm；Y = 25600/(π×21) = 388.02 /mm
#define X_PMM_DEFAULT   (PULSES_PER_REV / (3.14159265f * X_ROLLER_DIA_MM))
#define Y_PMM_DEFAULT   (PULSES_PER_REV / (3.14159265f * Y_PITCH_DIA_MM))

// ---------------- 舵机 / 钻孔时序 ----------------
#define SERVO_UP_DEG     90      // 抬起
#define SERVO_DOWN_DEG   45      // 下压
#define SERVO_TRAVEL_MS  500     // 舵机到位等待（含余量）
#define DRILL_MS         2000    // 钻孔保持时间（规格：2s）

// ---------------- 运动参数 ----------------
#define FEED_DEFAULT     10.0f    // 默认进给 mm/s
#define FEED_MIN         1.0f
#define FEED_MAX         50.0f    // 上限：主循环四项巡检约 40µs，>40mm/s 时脉冲节拍可能轻微滞后
#define PUL_HIGH_US      10      // 脉冲高电平宽度 µs
#define RAMP_PULSES      200     // 加减速斜坡脉冲数（约 0.6mm）
#define MIN_CRUISE_US    30      // 最短脉冲周期保护
#define MAX_INT_US       60000   // uint16 上限保护

// ---------------- EEPROM 布局 ----------------
#define EE_MAGIC         0xA5
#define EE_ADDR_MAGIC    0
#define EE_ADDR_XPMM     1        // float
#define EE_ADDR_YPMM     5        // float
#define PMM_MIN          50.0f    // 校准值合法范围
#define PMM_MAX          5000.0f

// ---------------- 串口行缓冲 ----------------
#define LINE_BUF         32

// ============================================================
// 运动引擎（非阻塞，micros() 定时，梯形加减速）
// ============================================================
struct Axis {
  uint8_t  pulMask;     // PORTD 位掩码
  uint8_t  dirMask;
  int32_t  pos;         // 绝对位置（脉冲，原点=0）
  bool     moving;
  bool     pulseHigh;   // 当前脉冲电平
  bool     dirPos;      // true = 正方向
  int32_t  total;       // 本次移动总脉冲数
  int32_t  done;        // 已完成脉冲数
  int32_t  rampLen;     // 实际斜坡长度（短行程自动折半）
  uint16_t cruiseInt;   // 巡航周期 µs
  uint16_t startInt;    // 起步周期 µs（= 巡航×4）
  uint32_t nextT;       // 下一脉冲边沿时刻 µs
};

static Axis ax, ay;                 // X 走带 / Y 横移
static float xpmm, ypmm;            // 脉冲/mm（EEPROM 校准值）
static float feedMmS = FEED_DEFAULT;

// ============================================================
// 打孔状态机
// ============================================================
enum State { ST_IDLE, ST_MOVE_X, ST_MOVE_Y,
             ST_DRILL_DOWN, ST_DRILL_DWELL, ST_DRILL_UP };
static State  st = ST_IDLE;
static bool   drilling = false;     // P 命令 = true（J 命令跳过钻孔）
static bool   estopped = false;    // 急停标志，须 O 清除
static float  targetXmm, targetYmm;
static uint32_t phaseT;            // 钻孔各阶段起始时刻

static Servo zServo;

// ---------------- 应答助手（F() 宏省 RAM） ----------------
static void replyOk()   { Serial.println(F("OK")); }
static void replyDone() { Serial.println(F("DONE")); }
static void replyErr(const __FlashStringHelper *m) {
  Serial.print(F("ERR ")); Serial.println(m);
}

// ---------------- EEPROM 配置 ----------------
static void saveConfig() {
  EEPROM.update(EE_ADDR_MAGIC, EE_MAGIC);
  EEPROM.put(EE_ADDR_XPMM, xpmm);
  EEPROM.put(EE_ADDR_YPMM, ypmm);
}
static void loadConfig() {
  bool valid = (EEPROM.read(EE_ADDR_MAGIC) == EE_MAGIC);
  if (valid) {
    EEPROM.get(EE_ADDR_XPMM, xpmm);
    EEPROM.get(EE_ADDR_YPMM, ypmm);
  }
  // 用 !(x>=min && x<=max) 形式：EEPROM 损坏读出 NaN 时也会被判无效
  if (!valid || !(xpmm >= PMM_MIN && xpmm <= PMM_MAX) ||
                !(ypmm >= PMM_MIN && ypmm <= PMM_MAX)) {
    xpmm = X_PMM_DEFAULT;
    ypmm = Y_PMM_DEFAULT;
    saveConfig();
  }
}

// ---------------- 运动引擎 ----------------
// 梯形速度：起步周期 = 巡航×4，RAMP_PULSES 内线性逼近巡航；
// 短行程（< 2×RAMP）自动退化为三角形速度曲线
static uint16_t moveInterval(const Axis &a) {
  int32_t i = a.done;
  int32_t r = (i < a.total - i) ? i : (a.total - i);   // min(i, total-i)
  if (r >= a.rampLen) return a.cruiseInt;
  // r ∈ [0, rampLen)：startInt → cruiseInt 线性插值
  uint32_t span = (uint32_t)(a.startInt - a.cruiseInt);
  uint32_t iv = a.cruiseInt + span * (uint32_t)(a.rampLen - r) / (uint32_t)a.rampLen;
  return (uint16_t)iv;
}

// 发起一次绝对移动（毫米）；零距离立即完成
static void beginMove(Axis &a, float mm, float pmm) {
  int32_t target = (int32_t)(mm * pmm + (mm >= 0 ? 0.5f : -0.5f));
  int32_t delta = target - a.pos;
  a.total = (delta < 0) ? -delta : delta;
  a.done = 0;
  a.pulseHigh = false;
  if (a.total == 0) { a.moving = false; return; }
  a.dirPos = (delta > 0);
  if (a.dirPos) PORTD |= a.dirMask; else PORTD &= ~a.dirMask;

  a.rampLen = RAMP_PULSES;
  if (a.rampLen > a.total / 2) a.rampLen = a.total / 2;

  uint32_t cruise = (uint32_t)(1000000.0f / (feedMmS * pmm));
  if (cruise < MIN_CRUISE_US) cruise = MIN_CRUISE_US;
  if (cruise > MAX_INT_US)    cruise = MAX_INT_US;
  uint32_t startI = cruise * 4;
  if (startI > MAX_INT_US)    startI = MAX_INT_US;
  a.cruiseInt = (uint16_t)cruise;
  a.startInt  = (uint16_t)startI;

  a.moving = true;
  a.nextT  = micros() + 500;   // 换向/方向建立延时
}

// 每圈调用：按当前斜坡周期发射脉冲（不阻塞）
static void axisTick(Axis &a) {
  if (!a.moving) return;
  uint32_t now = micros();
  if ((int32_t)(now - a.nextT) < 0) return;
  if (!a.pulseHigh) {
    PORTD |= a.pulMask;            // 上升沿
    a.pulseHigh = true;
    a.nextT = now + PUL_HIGH_US;
  } else {
    PORTD &= ~a.pulMask;           // 下降沿，一个完整脉冲结束
    a.pulseHigh = false;
    a.pos += a.dirPos ? 1 : -1;
    a.done++;
    if (a.done >= a.total) { a.moving = false; return; }
    a.nextT = now + moveInterval(a) - PUL_HIGH_US;
  }
}

// ---------------- 急停 ----------------
static void estopAll() {
  ax.moving = false;
  ay.moving = false;
  PORTD &= ~(ax.pulMask | ay.pulMask);   // 强制脉冲线拉低
  zServo.write(SERVO_UP_DEG);            // 抬钻
  st = ST_IDLE;
  estopped = true;
  Serial.println(F("OK ESTOP"));
}

// ---------------- 状态机推进 ----------------
static void finishTask() {
  st = ST_IDLE;
  replyDone();
}

static void runMachine() {
  switch (st) {
    case ST_MOVE_X:
      axisTick(ax);
      if (!ax.moving) { beginMove(ay, targetYmm, ypmm); st = ST_MOVE_Y; }
      break;
    case ST_MOVE_Y:
      axisTick(ay);
      if (!ay.moving) {
        if (drilling) {
          zServo.write(SERVO_DOWN_DEG);
          phaseT = millis();
          st = ST_DRILL_DOWN;
        } else {
          finishTask();               // J 命令到位
        }
      }
      break;
    case ST_DRILL_DOWN:                // 等舵机下压到位
      if (millis() - phaseT >= SERVO_TRAVEL_MS) { phaseT = millis(); st = ST_DRILL_DWELL; }
      break;
    case ST_DRILL_DWELL:               // 钻孔保持 2s
      if (millis() - phaseT >= DRILL_MS) {
        zServo.write(SERVO_UP_DEG);
        phaseT = millis();
        st = ST_DRILL_UP;
      }
      break;
    case ST_DRILL_UP:                  // 等舵机抬起到位
      if (millis() - phaseT >= SERVO_TRAVEL_MS) finishTask();
      break;
    default:
      break;
  }
}

// ---------------- 限位 / 急停按钮 ----------------
static void checkLimits() {
  // 预留限位：运动中触发（常开接地）即急停；未安装时上拉恒高无影响
  if ((ax.moving && digitalRead(X_LIM) == LOW) ||
      (ay.moving && digitalRead(Y_LIM) == LOW)) {
    estopAll();
  }
}

static void checkEstopBtn() {
  // 预留硬件急停：低电平持续 30ms 触发（时间去抖）
  static uint8_t  phase = 0;
  static uint32_t t0 = 0;
  bool low = (digitalRead(ESTOP_BTN) == LOW);
  if (phase == 0) {
    if (low) { phase = 1; t0 = millis(); }
  } else if (phase == 1) {
    if (!low) phase = 0;
    else if (millis() - t0 >= 30) {
      phase = 2;
      if (!estopped) estopAll();
    }
  } else {
    if (!low) phase = 0;
  }
}

// ---------------- 串口命令处理 ----------------
static bool parse2f(char *s, float &a, float &b) {
  char *e1, *e2;
  a = strtod(s, &e1);
  if (e1 == s) return false;
  b = strtod(e1, &e2);
  return (e2 != e1);
}

static void handleLine(char *buf) {
  // 去尾部空白
  size_t n = strlen(buf);
  while (n && (buf[n-1] == ' ' || buf[n-1] == '\t' || buf[n-1] == '\r')) buf[--n] = 0;
  if (n == 0) return;

  char c = buf[0];
  if (c >= 'a' && c <= 'z') c -= 32;    // 大小写不敏感
  bool idle = (st == ST_IDLE);

  switch (c) {
    case 'V':
      Serial.print(F(FW_NAME " " FW_VER " "));
      Serial.println(F("READY"));
      break;

    case 'R':
      estopAll();
      break;

    case 'Q':
      Serial.print(F("POS "));
      Serial.print(ax.pos / xpmm, 2);
      Serial.print(' ');
      Serial.println(ay.pos / ypmm, 2);
      break;

    case 'O':
      if (!idle) { replyErr(F("BUSY")); break; }
      ax.pos = 0;
      ay.pos = 0;
      estopped = false;
      replyOk();
      break;

    case 'Z': {
      if (!idle) { replyErr(F("BUSY")); break; }
      if (buf[1] == '0')      { zServo.write(SERVO_UP_DEG);   replyOk(); }
      else if (buf[1] == '1') { zServo.write(SERVO_DOWN_DEG); replyOk(); }
      else                    { replyErr(F("ARGS")); }
      break;
    }

    case 'F': {
      char *e;
      float f = strtod(buf + 1, &e);
      if (e == buf + 1) { replyErr(F("ARGS")); break; }
      if (f < FEED_MIN || f > FEED_MAX) { replyErr(F("RANGE")); break; }
      feedMmS = f;
      replyOk();
      break;
    }

    case 'C': {
      float nx, ny;
      if (!parse2f(buf + 1, nx, ny)) { replyErr(F("ARGS")); break; }
      if (nx < PMM_MIN || nx > PMM_MAX || ny < PMM_MIN || ny > PMM_MAX) {
        replyErr(F("RANGE"));
        break;
      }
      xpmm = nx;
      ypmm = ny;
      saveConfig();
      replyOk();
      break;
    }

    case 'J':
    case 'P': {
      if (estopped) { replyErr(F("ESTOP")); break; }   // 急停后须先 O 重新设原点
      if (!idle)    { replyErr(F("BUSY")); break; }
      float x, y;
      if (!parse2f(buf + 1, x, y)) { replyErr(F("ARGS")); break; }
      targetXmm = x;
      targetYmm = y;
      drilling = (c == 'P');
      beginMove(ax, x, xpmm);   // 零距离时立即 not-moving，状态机自然推进
      st = ST_MOVE_X;
      break;                    // 完成后统一回 DONE
    }

    default:
      replyErr(F("CMD"));
      break;
  }
}

// ---------------- 串口收行 ----------------
static char    lineBuf[LINE_BUF];
static uint8_t lineLen = 0;
static bool    lineOver = false;

static void serviceSerial() {
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (lineLen > 0 || lineOver) {
        if (lineOver) {
          replyErr(F("LONG"));
        } else {
          lineBuf[lineLen] = 0;
          handleLine(lineBuf);
        }
        lineLen = 0;
        lineOver = false;
      }
    } else if (lineLen < LINE_BUF - 1) {
      lineBuf[lineLen++] = ch;
    } else {
      lineOver = true;   // 超长：丢弃整行
    }
  }
}

// ============================================================
// Arduino 入口
// ============================================================
void setup() {
  // D2..D7 全部输出（PORTD 高 2 位是串口，不动）
  DDRD  |= 0xFC;
  // 全低：PUL/DIR = 0；ENA = 0（低有效 = 上电即锁相保持）
  PORTD &= 0x03;

  pinMode(X_LIM,     INPUT_PULLUP);
  pinMode(Y_LIM,     INPUT_PULLUP);
  pinMode(ESTOP_BTN, INPUT_PULLUP);

  zServo.attach(Z_SERVO);
  zServo.write(SERVO_UP_DEG);          // 上电默认抬钻

  loadConfig();

  Serial.begin(115200);
  delay(200);                          // 等 CH340 稳定再发开机横幅
  Serial.print(F(FW_NAME " " FW_VER " "));
  Serial.println(F("READY"));
}

void loop() {
  serviceSerial();   // 收命令（执行中收到非 R 命令回 ERR BUSY）
  checkEstopBtn();   // 预留硬件急停
  checkLimits();      // 预留限位保护
  runMachine();       // 脉冲发射 + 打孔状态机（非阻塞）
}
