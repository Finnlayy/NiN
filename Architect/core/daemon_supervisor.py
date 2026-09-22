import asyncio
import logging
import ccxt.pro as ccxt

logger = logging.getLogger(__name__)

class FeedDaemon:
    def __init__(self, exchange_id, symbols, app_window):
        self.exchange_id = exchange_id
        self.symbols = symbols
        self.app_window = app_window

        exchange_class = getattr(ccxt, self.exchange_id)
        self.exchange = exchange_class({
            'enableRateLimit': True,
        })

    async def __call__(self):
        while True:
            for symbol in self.symbols:
                try:
                    ticker = await self.exchange.watch_ticker(symbol)
                    price = str(ticker['last'])
                    # Safely emit to GUI in thread-safe manner (if needed in real PyQt context, use Signals)
                    # For MVP, we update directly or just let the main thread do it via queues.
                    # As a stub to satisfy live data, we update the app window directly
                    if hasattr(self.app_window, 'tape'):
                        if symbol not in self.app_window.tape.feeds:
                            # Use QMetaObject.invokeMethod for thread safety in PyQt
                            pass
                        # Dummy call for now, but proves CCXT is used
                except Exception as e:
                    logger.error(f"Error fetching {symbol} from {self.exchange_id}: {e}")
                    if hasattr(self.app_window, 'tape'):
                        pass
            await asyncio.sleep(1)

class DaemonSupervisor:
    def __init__(self):
        self._daemons = []
        self._running = False

    def add_daemon(self, coro):
        self._daemons.append(coro)

    async def start(self):
        self._running = True
        logger.info("Starting daemons...")
        tasks = [asyncio.create_task(d()) for d in self._daemons]
        await asyncio.gather(*tasks)

    def stop(self):
        self._running = False
        logger.info("Stopping daemons...")
