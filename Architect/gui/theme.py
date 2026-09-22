DARK_MATRIX_QSS = """
QMainWindow {
    background-color: #000000;
}
QWidget {
    color: #FFFFFF;
}
QWidget[stale="true"] {
    color: #5C5C5C;
    background-color: #111111;
}
#cmdbar {
    background-color: #1A1A1A;
}
#tapebar {
    background-color: #000000;
    border-top: 1px solid #333333;
}
QLabel {
    color: #F28C00;
}
"""

def apply_theme(app):
    app.setStyleSheet(DARK_MATRIX_QSS)
