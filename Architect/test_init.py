import sys
import asyncio
from core.state_machine import SystemExecutionState, MarketRegimeState
from core.daemon_supervisor import DaemonSupervisor
from PyQt6.QtWidgets import QApplication
from gui.app import GMTMainWindow

def test_imports():
    print("Testing core imports...")
    assert SystemExecutionState.PLANNING.name == "PLANNING"
    assert MarketRegimeState.BTC_SATELLITE.name == "BTC_SATELLITE"
    print("Core imports OK.")

async def dummy_daemon():
    await asyncio.sleep(0.1)

async def test_daemon():
    print("Testing DaemonSupervisor...")
    ds = DaemonSupervisor()
    ds.add_daemon(dummy_daemon)
    ds.stop()
    print("DaemonSupervisor OK.")

def test_gui():
    print("Testing GUI initialization...")
    app = QApplication.instance()
    if not app:
        app = QApplication(sys.argv)
    window = GMTMainWindow()
    assert window is not None
    print("GUI initialized OK.")

if __name__ == "__main__":
    test_imports()
    asyncio.run(test_daemon())
    test_gui()
    print("All tests passed.")
