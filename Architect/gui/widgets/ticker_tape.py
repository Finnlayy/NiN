from PyQt6.QtWidgets import QWidget, QHBoxLayout, QLabel, QGraphicsColorizeEffect
from PyQt6.QtCore import Qt, pyqtSlot
from PyQt6.QtGui import QColor

class FeedItem(QWidget):
    def __init__(self, symbol, price="---"):
        super().__init__()
        layout = QHBoxLayout()
        layout.setContentsMargins(0, 0, 10, 0)
        self.setLayout(layout)

        self.symbol = symbol
        self.label = QLabel(f"{symbol} {price}")
        self.label.setStyleSheet("color: #FFFFFF;")
        layout.addWidget(self.label)

        # Setup colorize effect for stale desaturation
        self.effect = QGraphicsColorizeEffect(self)
        self.effect.setColor(QColor("#5C5C5C"))
        self.effect.setStrength(1.0) # 1.0 means full desaturation (stale until live)
        self.setGraphicsEffect(self.effect)
        self.setProperty("stale", "true")

    def update_price(self, price):
        self.label.setText(f"{self.symbol} {price}")
        self.set_stale(False)

    def set_stale(self, is_stale):
        if is_stale:
            self.effect.setStrength(1.0)
            self.setProperty("stale", "true")
        else:
            self.effect.setStrength(0.0)
            self.setProperty("stale", "false")
        self.style().unpolish(self)
        self.style().polish(self)

class TickerTape(QWidget):
    def __init__(self):
        super().__init__()
        self.setObjectName("tapebar")
        layout = QHBoxLayout()
        layout.setContentsMargins(5, 5, 5, 5)
        self.setLayout(layout)

        self.feeds = {}

        # Initialize feeds without dummy data (will be populated by ccxt)
        self.add_feed("BTC/USD")
        self.add_feed("ETH/USD")

        layout.addStretch()

    def add_feed(self, symbol, price="---"):
        feed = FeedItem(symbol, price)
        self.feeds[symbol] = feed
        self.layout().insertWidget(self.layout().count() - 1, feed)

    @pyqtSlot(str, str)
    def update_feed_price(self, symbol, price):
        if symbol in self.feeds:
            self.feeds[symbol].update_price(price)

    def mark_feed_stale(self, symbol, is_stale):
        if symbol in self.feeds:
            self.feeds[symbol].set_stale(is_stale)
