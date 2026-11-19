export const projectName = 'led-indicator';
export const boardProfile = Object.freeze({
  kind: projectName, label: '红色 LED 电源指示板', voltage: 5, ledColor: 'red',
  resistanceMin: 220, resistanceMax: 1000, resistanceDefault: 330,
  width: 42, height: 20,
});

export const nets = ['VIN', 'LED_A', 'GND'];

export const parts = [
  { ref: 'J1', type: 'Input', value: 'DC IN', sheet: [38.1, 38.1], board: [6, 8], pins: [
    { number: '1', name: 'VIN', net: 'VIN', symbol: [5.08, 0, 180], pad: [0, 0] },
    { number: '2', name: 'GND', net: 'GND', symbol: [5.08, -5.08, 180], pad: [0, 2.54] },
  ] },
  { ref: 'R1', type: 'Resistor', value: ({ resistance }) => `${resistance}R`, sheet: [66.04, 38.1], board: [16, 8], pins: [
    { number: '1', name: '1', net: 'VIN', symbol: [-5.08, 0, 0], pad: [0, 0] },
    { number: '2', name: '2', net: 'LED_A', symbol: [5.08, 0, 180], pad: [7.62, 0] },
  ] },
  { ref: 'D1', type: 'LED', value: 'Red LED', sheet: [91.44, 38.1], board: [34, 8], pins: [
    { number: '1', name: 'K', net: 'GND', symbol: [5.08, 0, 180], pad: [0, 2.54] },
    { number: '2', name: 'A', net: 'LED_A', symbol: [-5.08, 0, 0], pad: [0, 0] },
  ] },
];

export const sheetBends = { VIN: [], LED_A: [], GND: [[48.26, 43.18], [48.26, 50.8], [101.6, 50.8], [101.6, 38.1]] };

export const scale = value => Number(value.toFixed(4));

export function designFor(input) {
  const voltage = Number(input.voltage);
  const resistance = Number(input.resistance);
  const { kind, voltage: supportedVoltage, resistanceMin, resistanceMax, width, height } = boardProfile;
  if (input.kind !== kind || voltage !== supportedVoltage || !Number.isInteger(resistance) || resistance < resistanceMin || resistance > resistanceMax) {
    throw new Error(`首版支持 ${supportedVoltage}V 红色 LED 指示板，限流电阻取 ${resistanceMin}–${resistanceMax} Ω 的整数。`);
  }
  return { kind, voltage, resistance, width, height };
}

export function drawingParts(spec) {
  return parts.map(part => ({ ...part, value: typeof part.value === 'function' ? part.value(spec) : part.value }));
}

export function connections(components, space) {
  return nets.map((net, index) => {
    const endpoints = components.flatMap(part => part.pins.filter(pin => pin.net === net).map(pin => ({ part, pin })));
    const points = endpoints.map(({ part, pin }) => {
      if (space === 'sheet') return [scale(part.sheet[0] + pin.symbol[0]), scale(part.sheet[1] - pin.symbol[1])];
      return [scale(part.board[0] + pin.pad[0]), scale(part.board[1] + pin.pad[1])];
    });
    if (space === 'sheet') points.splice(1, 0, ...sheetBends[net]);
    return { net, id: index + 1, endpoints, points, layer: net === 'GND' ? 'B.Cu' : 'F.Cu' };
  });
}

export function segments(points) {
  return points.slice(1).map((point, index) => [points[index], point]);
}
