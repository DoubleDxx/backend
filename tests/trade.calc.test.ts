import { calcAvgExitPrice, calcRealizedPnl, calcPips, calcRR } from '../src/modules/trades/trade.calc'

describe('trade.calc', () => {
  test('avg exit price weighted', () => {
    const legs = [
      { size: 1, exit_price: 101 },
      { size: 2, exit_price: 103 }
    ]
    expect(calcAvgExitPrice(legs)).toBeCloseTo(102.3333, 4)
  })

  test('realized pnl BUY', () => {
    const pnl = calcRealizedPnl('BUY', 100, [
      { size: 1, exit_price: 101 },
      { size: 2, exit_price: 99 }
    ], 1, 0)
    expect(pnl).toBeCloseTo(1 - 2, 4)
  })

  test('realized pnl SELL', () => {
    const pnl = calcRealizedPnl('SELL', 100, [
      { size: 1, exit_price: 98 },
      { size: 2, exit_price: 101 }
    ], 1, 0)
    expect(pnl).toBeCloseTo(2 - 2, 4)
  })

  test('pips', () => {
    expect(calcPips(1.2000, 1.2050, 0.0001)).toBeCloseTo(50, 5)
  })

  test('rr', () => {
    expect(calcRR(100, 95, 110)).toBeCloseTo(2, 4)
  })
})
