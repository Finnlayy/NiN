import { useEffect, useRef } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, Time } from 'lightweight-charts';

interface OHLCData {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface TradingViewChartProps {
  data: OHLCData[];
  highlightStartIndex?: number;
  highlightEndIndex?: number;
}

export default function TradingViewChart({ data, highlightStartIndex, highlightEndIndex }: TradingViewChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0a0c10' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      width: chartContainerRef.current.clientWidth,
      height: 400,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      }
    });

    chartRef.current = chart;

    const candlestickSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    candlestickSeries.setData(data);
    seriesRef.current = candlestickSeries;

    // Add markers for highlighted structure if provided
    if (highlightStartIndex !== undefined && highlightEndIndex !== undefined && highlightStartIndex < data.length && highlightEndIndex < data.length) {
      const markers: any[] = [];
      
      // Mark the start
      markers.push({
        time: data[highlightStartIndex].time,
        position: 'belowBar',
        color: '#a855f7',
        shape: 'arrowUp',
        text: 'Structure Start',
      });

      // Mark the end
      markers.push({
        time: data[highlightEndIndex].time,
        position: 'aboveBar',
        color: '#a855f7',
        shape: 'arrowDown',
        text: 'Structure End',
      });

      candlestickSeries.setMarkers(markers);
    }

    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [data, highlightStartIndex, highlightEndIndex]);

  return <div ref={chartContainerRef} className="w-full h-[400px]" />;
}
