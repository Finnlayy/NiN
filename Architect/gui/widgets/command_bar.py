from PyQt6.QtWidgets import QWidget, QHBoxLayout, QLabel, QPushButton
from PyQt6.QtCore import Qt, QTimer, QDateTime

class CommandBar(QWidget):
    def __init__(self):
        super().__init__()
        self.setObjectName("cmdbar")
        layout = QHBoxLayout()
        self.setLayout(layout)

        self.mode_label = QLabel("[LIVE]")
        self.mode_label.setStyleSheet("color: #00C176; font-weight: bold;")
        layout.addWidget(self.mode_label)

        self.clock_label = QLabel()
        layout.addWidget(self.clock_label)
        layout.addStretch()

        self.batch_exit_btn = QPushButton("[⚡ BATCH EXIT]")
        self.batch_exit_btn.setStyleSheet("color: #FF4D4F;")
        layout.addWidget(self.batch_exit_btn)

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.update_clock)
        self.timer.start(1000)
        self.update_clock()

    def update_clock(self):
        time = QDateTime.currentDateTimeUtc().toString("yyyy-MM-dd HH:mm:ss 'UTC'")
        self.clock_label.setText(time)
