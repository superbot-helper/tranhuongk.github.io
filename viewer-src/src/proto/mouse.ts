// Port of UltraViewerProtocol/MouseMessage.swift.
// Application text emitted through Form1.SendMSG. Routing, transport encryption,
// acknowledgements and coordinate scaling belong to the caller; callers send the
// result as ASCII with formatFlag=false.

/** Windows mouse window messages. 0x203/0x206/0x209 (double-click) exist only to validate, as in Swift. */
export enum MouseButtonMessage {
  LeftDown = 0x201,
  LeftUp = 0x202,
  LeftDoubleClick = 0x203,
  RightDown = 0x204,
  RightUp = 0x205,
  RightDoubleClick = 0x206,
  MiddleDown = 0x207,
  MiddleUp = 0x208,
  MiddleDoubleClick = 0x209,
}

/** Swift Button.allCases in raw-value order. */
export const MOUSE_BUTTON_MESSAGES: readonly MouseButtonMessage[] = [
  MouseButtonMessage.LeftDown,
  MouseButtonMessage.LeftUp,
  MouseButtonMessage.LeftDoubleClick,
  MouseButtonMessage.RightDown,
  MouseButtonMessage.RightUp,
  MouseButtonMessage.RightDoubleClick,
  MouseButtonMessage.MiddleDown,
  MouseButtonMessage.MiddleUp,
  MouseButtonMessage.MiddleDoubleClick,
];

const WM_MOUSEMOVE = 0x200;
const WM_MOUSEWHEEL = 0x20a;

/** Swift `Button(rawValue:) != nil`. */
export function isMouseButtonMessage(value: number): value is MouseButtonMessage {
  return Number.isInteger(value) && value >= 0x201 && value <= 0x209;
}

// Swift's Int32/Int16/UInt16 parameter types become range checks, so a bad
// value fails loudly instead of emitting "NaN" or a fractional number.
function int32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError(`${name} must be a signed 32-bit integer`);
  }
  return value;
}

function int16(value: number, name: string): number {
  if (!Number.isInteger(value) || value < -0x8000 || value > 0x7fff) {
    throw new RangeError(`${name} must be a signed 16-bit integer`);
  }
  return value;
}

function join(message: number, parameters: number[]): string {
  return ['8', String(message), ...parameters.map(String)].join('|||');
}

/** `.move`: three separate signed Long parameters; x/y are already remote desktop coordinates. */
export function mouseMoveText(wParam: number, x: number, y: number): string {
  return join(WM_MOUSEMOVE, [int32(wParam, 'wParam'), int32(x, 'x'), int32(y, 'y')]);
}

/** `.button`: the two original signed Long words; a changed position is sent separately before it. */
export function mouseButtonText(msg: MouseButtonMessage, wParam: number, lParam: number): string {
  if (!isMouseButtonMessage(msg)) throw new RangeError('msg is not a mouse button message');
  return join(msg, [int32(wParam, 'wParam'), int32(lParam, 'lParam')]);
}

/** `.verticalWheel` (WM_MOUSEWHEEL 0x20a): the signed delta stays packed in wParam's high word. */
export function mouseWheelText(wParam: number, lParam: number): string {
  return join(WM_MOUSEWHEEL, [int32(wParam, 'wParam'), int32(lParam, 'lParam')]);
}

/** Win32's two 16-bit coordinate words (x low, y high), including negative values, as a signed Int32. */
export function packedPosition(x: number, y: number): number {
  return ((int16(x, 'x') & 0xffff) | ((int16(y, 'y') & 0xffff) << 16)) | 0;
}

/** `keyFlags | UInt16(bitPattern: delta) << 16` as a signed Int32. */
export function wheelWParam(delta: number, flags: number): number {
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffff) throw new RangeError('flags must be an unsigned 16-bit integer');
  return (flags | ((int16(delta, 'delta') & 0xffff) << 16)) | 0;
}
