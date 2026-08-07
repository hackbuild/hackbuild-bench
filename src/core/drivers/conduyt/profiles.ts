/**
 * Board profiles, cut down from conduyt's protocol/board-profiles.json to what
 * the bench needs to name a board and label its pins.
 *
 * The board itself is the authority on what it can do: HELLO carries the pin
 * count and a capability bitmask per pin. These profiles only add what the
 * wire has no room for, which is the silkscreen names, the vendor's analog and
 * pwm wiring, and how the board takes new firmware from a browser. Nothing
 * here overrides what the board reported.
 *
 * The 8 byte mcu id in HELLO is a per unit serial, not a family code, so it
 * cannot name a board by itself. matchBoard narrows on usb vid and pid first
 * and pin count second, and returns null instead of picking between two boards
 * that share a bridge chip.
 */

export interface UsbId {
  vid: number
  pid?: number
}

export interface McuProfile {
  id: string
  name: string
  adcBits: number
  pwmBits: number
  /** what the 8 byte mcu id in HELLO is read from on this family. */
  idSource: string
}

export interface BoardProfile {
  id: string
  name: string
  /** key into MCUS. */
  mcu: string
  pinCount: number
  i2cBuses: number
  /** silkscreen names, indexed by the pin number conduyt reports. */
  pinNames: string[]
  analogPins: number[]
  pwmPins: number[]
  /** how the browser can flash it, or null when it needs a cable side tool. */
  browserFlash: string | null
  usb: UsbId[]
}

const names = (s: string): string[] => s.split(' ')

const MCUS: Record<string, McuProfile> = {
  atmega2560: {
    id: 'atmega2560',
    name: 'Atmel ATmega2560',
    adcBits: 10,
    pwmBits: 8,
    idSource: 'no factory unique id on this family, the field is zero filled',
  },
  atmega328p: {
    id: 'atmega328p',
    name: 'Atmel ATmega328P',
    adcBits: 10,
    pwmBits: 8,
    idSource: 'no factory unique id on this family, the field is zero filled',
  },
  atmega32u4: {
    id: 'atmega32u4',
    name: 'Atmel ATmega32U4',
    adcBits: 10,
    pwmBits: 8,
    idSource: 'no factory unique id on this family, the field is zero filled',
  },
  atmega4809: {
    id: 'atmega4809',
    name: 'Atmel ATmega4809 (megaAVR)',
    adcBits: 10,
    pwmBits: 8,
    idSource: 'no factory unique id on this family, the field is zero filled',
  },
  esp32: {
    id: 'esp32',
    name: 'Espressif ESP32 (classic)',
    adcBits: 12,
    pwmBits: 8,
    idSource: 'factory mac from efuse',
  },
  esp32c3: {
    id: 'esp32c3',
    name: 'Espressif ESP32-C3',
    adcBits: 12,
    pwmBits: 8,
    idSource: 'factory mac from efuse',
  },
  esp32s2: {
    id: 'esp32s2',
    name: 'Espressif ESP32-S2',
    adcBits: 13,
    pwmBits: 8,
    idSource: 'factory mac from efuse',
  },
  esp32s3: {
    id: 'esp32s3',
    name: 'Espressif ESP32-S3',
    adcBits: 12,
    pwmBits: 8,
    idSource: 'factory mac from efuse',
  },
  esp8266: {
    id: 'esp8266',
    name: 'Espressif ESP8266',
    adcBits: 10,
    pwmBits: 10,
    idSource: 'chip id, 24 bits padded out',
  },
  imxrt1062: {
    id: 'imxrt1062',
    name: 'NXP i.MX RT1062',
    adcBits: 12,
    pwmBits: 16,
    idSource: 'ocotp fuses',
  },
  kinetis_k66: {
    id: 'kinetis_k66',
    name: 'NXP Kinetis K66 (MK66FX1M0)',
    adcBits: 16,
    pwmBits: 16,
    idSource: 'kinetis unique id, upper 64 bits',
  },
  nrf52840: {
    id: 'nrf52840',
    name: 'Nordic nRF52840',
    adcBits: 12,
    pwmBits: 8,
    idSource: 'ficr deviceid',
  },
  ra4m1: {
    id: 'ra4m1',
    name: 'Renesas RA4M1',
    adcBits: 14,
    pwmBits: 8,
    idSource: 'renesas unique id',
  },
  rp2040: {
    id: 'rp2040',
    name: 'Raspberry Pi RP2040',
    adcBits: 12,
    pwmBits: 16,
    idSource: 'jedec ruid off the flash chip',
  },
}

const BOARDS: BoardProfile[] = [
  {
    id: 'arduino_nano_esp32',
    name: 'Arduino Nano ESP32',
    mcu: 'esp32s3',
    pinCount: 25,
    i2cBuses: 2,
    pinNames: names(
      'D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 LED_RED LED_GREEN LED_BLUE A0 A1 ' +
      'A2 A3 A4 A5 A6 A7'
    ),
    analogPins: [2, 3, 4, 5, 6, 7, 17, 18, 19, 20],
    pwmPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24],
    browserFlash: 'esp-web-tools',
    usb: [{ vid: 0x2341, pid: 0x0070 }],
  },
  {
    id: 'esp32-c3-devkitm-1',
    name: 'ESP32-C3 DevKitM-1',
    mcu: 'esp32c3',
    pinCount: 22,
    i2cBuses: 1,
    pinNames: names(
      'GPIO0 GPIO1 GPIO2 GPIO3 GPIO4 GPIO5 GPIO6 GPIO7 GPIO8 GPIO9 GPIO10 GPIO11 ' +
      'GPIO12 GPIO13 GPIO14 GPIO15 GPIO16 GPIO17 GPIO18 GPIO19 GPIO20 GPIO21'
    ),
    analogPins: [0, 1, 2, 3, 4],
    pwmPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19, 20, 21],
    browserFlash: 'esp-web-tools',
    usb: [{ vid: 0x303a, pid: 0x1001 }, { vid: 0x10c4, pid: 0xea60 }, { vid: 0x1a86, pid: 0x7523 }],
  },
  {
    id: 'esp32-s2-saola-1',
    name: 'ESP32-S2 Saola-1',
    mcu: 'esp32s2',
    pinCount: 47,
    i2cBuses: 2,
    pinNames: names(
      'GPIO0 GPIO1 GPIO2 GPIO3 GPIO4 GPIO5 GPIO6 GPIO7 GPIO8 GPIO9 GPIO10 GPIO11 ' +
      'GPIO12 GPIO13 GPIO14 GPIO15 GPIO16 GPIO17 GPIO18 GPIO19 GPIO20 GPIO21 GPIO22 ' +
      'GPIO23 GPIO24 GPIO25 GPIO26 GPIO27 GPIO28 GPIO29 GPIO30 GPIO31 GPIO32 GPIO33 ' +
      'GPIO34 GPIO35 GPIO36 GPIO37 GPIO38 GPIO39 GPIO40 GPIO41 GPIO42 GPIO43 GPIO44 ' +
      'GPIO45 GPIO46'
    ),
    analogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    pwmPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45],
    browserFlash: 'esp-web-tools',
    usb: [{ vid: 0x303a, pid: 0x0002 }, { vid: 0x10c4, pid: 0xea60 }],
  },
  {
    id: 'esp32-s3-devkitc-1',
    name: 'ESP32-S3 DevKitC-1',
    mcu: 'esp32s3',
    pinCount: 49,
    i2cBuses: 2,
    pinNames: names(
      'GPIO0 GPIO1 GPIO2 GPIO3 GPIO4 GPIO5 GPIO6 GPIO7 GPIO8 GPIO9 GPIO10 GPIO11 ' +
      'GPIO12 GPIO13 GPIO14 GPIO15 GPIO16 GPIO17 GPIO18 GPIO19 GPIO20 GPIO21 GPIO22 ' +
      'GPIO23 GPIO24 GPIO25 GPIO26 GPIO27 GPIO28 GPIO29 GPIO30 GPIO31 GPIO32 GPIO33 ' +
      'GPIO34 GPIO35 GPIO36 GPIO37 GPIO38 GPIO39 GPIO40 GPIO41 GPIO42 GPIO43 GPIO44 ' +
      'GPIO45 GPIO46 GPIO47 GPIO48'
    ),
    analogPins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    pwmPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48],
    browserFlash: 'esp-web-tools',
    usb: [{ vid: 0x303a, pid: 0x1001 }, { vid: 0x10c4, pid: 0xea60 }],
  },
  {
    id: 'esp32dev',
    name: 'ESP32 DevKit',
    mcu: 'esp32',
    pinCount: 40,
    i2cBuses: 2,
    pinNames: names(
      'GPIO0 GPIO1 GPIO2 GPIO3 GPIO4 GPIO5 GPIO6 GPIO7 GPIO8 GPIO9 GPIO10 GPIO11 ' +
      'GPIO12 GPIO13 GPIO14 GPIO15 GPIO16 GPIO17 GPIO18 GPIO19 GPIO20 GPIO21 GPIO22 ' +
      'GPIO23 GPIO24 GPIO25 GPIO26 GPIO27 GPIO28 GPIO29 GPIO30 GPIO31 GPIO32 GPIO33 ' +
      'GPIO34 GPIO35 GPIO36 GPIO37 GPIO38 GPIO39'
    ),
    analogPins: [32, 33, 34, 35, 36, 37, 38, 39],
    pwmPins: [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33],
    browserFlash: 'esp-web-tools',
    usb: [{ vid: 0x10c4, pid: 0xea60 }, { vid: 0x1a86, pid: 0x7523 }],
  },
  {
    id: 'leonardo',
    name: 'Arduino Leonardo',
    mcu: 'atmega32u4',
    pinCount: 30,
    i2cBuses: 1,
    pinNames: names(
      'D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 D14 D15 D16 D17 A0 A1 A2 A3 A4 ' +
      'A5 A6 A7 A8 A9 A10 A11'
    ),
    analogPins: [4, 6, 8, 9, 10, 12, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
    pwmPins: [3, 5, 6, 9, 10, 11, 13],
    browserFlash: null,
    usb: [{ vid: 0x2341, pid: 0x8036 }],
  },
  {
    id: 'mega2560',
    name: 'Arduino Mega 2560',
    mcu: 'atmega2560',
    pinCount: 70,
    i2cBuses: 1,
    pinNames: names(
      'D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 D14 D15 D16 D17 D18 D19 D20 D21 ' +
      'D22 D23 D24 D25 D26 D27 D28 D29 D30 D31 D32 D33 D34 D35 D36 D37 D38 D39 D40 ' +
      'D41 D42 D43 D44 D45 D46 D47 D48 D49 D50 D51 D52 D53 A0 A1 A2 A3 A4 A5 A6 A7 A8 ' +
      'A9 A10 A11 A12 A13 A14 A15'
    ),
    analogPins: [54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69],
    pwmPins: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 44, 45, 46],
    browserFlash: null,
    usb: [{ vid: 0x2341, pid: 0x0042 }, { vid: 0x2341, pid: 0x0010 }],
  },
  {
    id: 'nano',
    name: 'Arduino Nano',
    mcu: 'atmega328p',
    pinCount: 22,
    i2cBuses: 1,
    pinNames: names('D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 A0 A1 A2 A3 A4 A5 A6 A7'),
    analogPins: [14, 15, 16, 17, 18, 19, 20, 21],
    pwmPins: [3, 5, 6, 9, 10, 11],
    browserFlash: null,
    usb: [{ vid: 0x0403, pid: 0x6001 }, { vid: 0x1a86, pid: 0x7523 }],
  },
  {
    id: 'nano_every',
    name: 'Arduino Nano Every',
    mcu: 'atmega4809',
    pinCount: 22,
    i2cBuses: 1,
    pinNames: names('D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 A0 A1 A2 A3 A4 A5 A6 A7'),
    analogPins: [14, 15, 16, 17, 18, 19, 20, 21],
    pwmPins: [3, 5, 6, 9, 10],
    browserFlash: null,
    usb: [{ vid: 0x2341, pid: 0x0058 }],
  },
  {
    id: 'nodemcuv2',
    name: 'NodeMCU 1.0 (ESP-12E)',
    mcu: 'esp8266',
    pinCount: 18,
    i2cBuses: 1,
    pinNames: names(
      'GPIO0 GPIO1 GPIO2 GPIO3 GPIO4 GPIO5 GPIO6 GPIO7 GPIO8 GPIO9 GPIO10 GPIO11 ' +
      'GPIO12 GPIO13 GPIO14 GPIO15 GPIO16 A0'
    ),
    analogPins: [17],
    pwmPins: [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16],
    browserFlash: null,
    usb: [{ vid: 0x1a86, pid: 0x7523 }, { vid: 0x10c4, pid: 0xea60 }],
  },
  {
    id: 'nrf52840_dk',
    name: 'nRF52840 DK (PCA10056)',
    mcu: 'nrf52840',
    pinCount: 48,
    i2cBuses: 1,
    pinNames: names(
      'P0_00 P0_01 P0_02 P0_03 P0_04 P0_05 P0_06 P0_07 P0_08 P0_09 P0_10 P0_11 P0_12 ' +
      'P0_13 P0_14 P0_15 P0_16 P0_17 P0_18 P0_19 P0_20 P0_21 P0_22 P0_23 P0_24 P0_25 ' +
      'P0_26 P0_27 P0_28 P0_29 P0_30 P0_31 P1_00 P1_01 P1_02 P1_03 P1_04 P1_05 P1_06 ' +
      'P1_07 P1_08 P1_09 P1_10 P1_11 P1_12 P1_13 P1_14 P1_15'
    ),
    analogPins: [2, 3, 4, 5, 28, 29, 30, 31],
    pwmPins: [2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 18, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47],
    browserFlash: null,
    usb: [{ vid: 0x1366, pid: 0x1015 }],
  },
  {
    id: 'pico',
    name: 'Raspberry Pi Pico',
    mcu: 'rp2040',
    pinCount: 30,
    i2cBuses: 2,
    pinNames: names(
      'GP0 GP1 GP2 GP3 GP4 GP5 GP6 GP7 GP8 GP9 GP10 GP11 GP12 GP13 GP14 GP15 GP16 ' +
      'GP17 GP18 GP19 GP20 GP21 GP22 GP23 GP24 GP25 GP26 GP27 GP28 GP29'
    ),
    analogPins: [26, 27, 28],
    pwmPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25, 26, 27, 28],
    browserFlash: 'uf2 over webusb',
    usb: [{ vid: 0x2e8a, pid: 0x000a }],
  },
  {
    id: 'teensy36',
    name: 'Teensy 3.6',
    mcu: 'kinetis_k66',
    pinCount: 58,
    i2cBuses: 3,
    pinNames: names(
      'D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 D14 D15 D16 D17 D18 D19 D20 D21 ' +
      'D22 D23 D24 D25 D26 D27 D28 D29 D30 D31 D32 D33 D34 D35 D36 D37 D38 D39 D40 ' +
      'D41 D42 D43 D44 D45 D46 D47 D48 D49 D50 D51 D52 D53 D54 D55 D56 D57'
    ),
    analogPins: [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 31, 32, 33, 34, 35, 36, 37, 38, 39, 49, 50],
    pwmPins: [2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 16, 17, 20, 21, 22, 23, 29, 30, 35, 36, 37, 38],
    browserFlash: null,
    usb: [{ vid: 0x16c0, pid: 0x0483 }],
  },
  {
    id: 'teensy40',
    name: 'Teensy 4.0',
    mcu: 'imxrt1062',
    pinCount: 40,
    i2cBuses: 3,
    pinNames: names(
      'D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 D14 D15 D16 D17 D18 D19 D20 D21 ' +
      'D22 D23 D24 D25 D26 D27 D28 D29 D30 D31 D32 D33 D34 D35 D36 D37 D38 D39'
    ),
    analogPins: [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27],
    pwmPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 22, 23, 24, 25, 28, 29, 33, 34, 35, 36, 37, 38, 39],
    browserFlash: null,
    usb: [{ vid: 0x16c0, pid: 0x0483 }],
  },
  {
    id: 'teensy41',
    name: 'Teensy 4.1',
    mcu: 'imxrt1062',
    pinCount: 55,
    i2cBuses: 3,
    pinNames: names(
      'D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 D14 D15 D16 D17 D18 D19 D20 D21 ' +
      'D22 D23 D24 D25 D26 D27 D28 D29 D30 D31 D32 D33 D34 D35 D36 D37 D38 D39 D40 ' +
      'D41 D42 D43 D44 D45 D46 D47 D48 D49 D50 D51 D52 D53 D54'
    ),
    analogPins: [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 38, 39, 40, 41],
    pwmPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 22, 23, 24, 25, 28, 29, 33, 36, 37, 42, 43, 44, 45, 46, 47, 51, 54],
    browserFlash: null,
    usb: [{ vid: 0x16c0, pid: 0x0483 }],
  },
  {
    id: 'uno',
    name: 'Arduino Uno R3',
    mcu: 'atmega328p',
    pinCount: 20,
    i2cBuses: 1,
    pinNames: names('D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 A0 A1 A2 A3 A4 A5'),
    analogPins: [14, 15, 16, 17, 18, 19],
    pwmPins: [3, 5, 6, 9, 10, 11],
    browserFlash: null,
    usb: [{ vid: 0x2341, pid: 0x0043 }, { vid: 0x2341, pid: 0x0001 }, { vid: 0x1a86, pid: 0x7523 }],
  },
  {
    id: 'uno_r4_minima',
    name: 'Arduino Uno R4 Minima',
    mcu: 'ra4m1',
    pinCount: 20,
    i2cBuses: 1,
    pinNames: names('D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 A0 A1 A2 A3 A4 A5'),
    analogPins: [14, 15, 16, 17, 18, 19],
    pwmPins: [3, 5, 6, 9, 10, 11, 12, 13],
    browserFlash: 'webusb dfu',
    usb: [{ vid: 0x2341, pid: 0x0069 }],
  },
  {
    id: 'uno_r4_wifi',
    name: 'Arduino Uno R4 WiFi',
    mcu: 'ra4m1',
    pinCount: 20,
    i2cBuses: 2,
    pinNames: names('D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13 A0 A1 A2 A3 A4 A5'),
    analogPins: [14, 15, 16, 17, 18, 19],
    pwmPins: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 18, 19],
    browserFlash: 'webusb dfu',
    usb: [{ vid: 0x2341, pid: 0x1002 }],
  },
]

/** Every board profile, in the order conduyt lists them. */
export function allBoards(): BoardProfile[] {
  return BOARDS
}

/** The mcu family behind a profile, for adc width and where the id came from. */
export function mcuProfile(mcu: string): McuProfile | null {
  return MCUS[mcu] ?? null
}

export function boardProfile(id: string): BoardProfile | null {
  return BOARDS.find((b) => b.id === id) ?? null
}

/** Boards built on one mcu family. Lookup by mcu id. */
export function boardsForMcu(mcu: string): BoardProfile[] {
  return BOARDS.filter((b) => b.mcu === mcu)
}

/**
 * Boards that show up on this usb id. A bare vid matches every board using
 * that bridge chip, which is most of them, so pass the pid when you have one.
 */
export function boardsForUsb(vid: number, pid?: number): BoardProfile[] {
  return BOARDS.filter((b) =>
    b.usb.some((u) => u.vid === vid && (pid === undefined || u.pid === undefined || u.pid === pid)),
  )
}

export interface BoardHint {
  vid?: number
  pid?: number
  /** pin count the board reported over HELLO. */
  pinCount?: number
}

/**
 * Name the board from what the transport and HELLO gave us. Returns null when
 * the evidence fits more than one board, since a CH340 on 22 pins could be a
 * Nano or a NodeMCU and the panel should say so rather than pick.
 */
export function matchBoard(hint: BoardHint): BoardProfile | null {
  let candidates =
    hint.vid === undefined ? BOARDS.slice() : boardsForUsb(hint.vid, hint.pid)
  if (candidates.length > 1 && hint.pinCount !== undefined) {
    const byPins = candidates.filter((b) => b.pinCount === hint.pinCount)
    if (byPins.length) candidates = byPins
  }
  return candidates.length === 1 ? candidates[0] : null
}

/** Silkscreen name for a pin, falling back to the bare number. */
export function pinLabel(profile: BoardProfile | null, pin: number): string {
  const name = profile?.pinNames[pin]
  return name ?? `pin ${pin}`
}

/** Boards the conduyt playground can flash without a cable side tool. */
export function browserFlashBoards(): BoardProfile[] {
  return BOARDS.filter((b) => b.browserFlash !== null)
}

/** One line naming the boards that take firmware straight from the browser. */
export function browserFlashSummary(): string {
  const flashable = browserFlashBoards()
  if (!flashable.length) return 'no board in this table flashes from a browser'
  return `${flashable.map((b) => b.name.toLowerCase()).join(', ')} flash from the browser. the rest need esptool, avrdude, or the vendor tool over a cable.`
}
