export function generateOHLCData(numPoints = 100) {
  const data = [];
  let time = Math.floor(Date.now() / 1000) - numPoints * 3600; // hourly candles
  let currentPrice = 64000;

  for (let i = 0; i < numPoints; i++) {
    const volatility = 200;
    const open = currentPrice;
    const high = open + Math.random() * volatility;
    const low = open - Math.random() * volatility;
    const close = low + Math.random() * (high - low);
    
    data.push({
      time: time as any, // Unix timestamp for lightweight charts
      open,
      high,
      low,
      close
    });

    currentPrice = close;
    time += 3600;
  }

  return data;
}
