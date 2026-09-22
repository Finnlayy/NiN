import sys
from PyQt6.QtWidgets import QApplication, QMainWindow, QVBoxLayout, QWidget, QLabel
from PyQt6.QtCore import Qt
from gui.theme import apply_theme
from gui.widgets.command_bar import CommandBar
from gui.widgets.ticker_tape import TickerTape
from gui.views.unified_chart_tab import UnifiedChartTab

class GMTMainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("GMT (Global Market Terminal) - OMEGA")
        self.resize(1280, 720)

        main_widget = QWidget()
        self.setCentralWidget(main_widget)

        layout = QVBoxLayout()
        main_widget.setLayout(layout)

        self.cmd_bar = CommandBar()
        layout.addWidget(self.cmd_bar)

        self.chart = UnifiedChartTab()
        layout.addWidget(self.chart)

        self.tape = TickerTape()
        layout.addWidget(self.tape)

def main():
    app = QApplication(sys.argv)
    apply_theme(app)
    window = GMTMainWindow()
    window.show()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
