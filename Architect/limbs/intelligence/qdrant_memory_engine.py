from qdrant_client import QdrantClient
import logging
import os

logger = logging.getLogger(__name__)

class QdrantMemoryEngine:
    def __init__(self, config):
        self.config = config
        self.client = self._initialize_client()

    def _initialize_client(self):
        if self.config.QDRANT_URL and self.config.QDRANT_API_KEY:
            try:
                # Try Cloud Connection
                client = QdrantClient(
                    url=self.config.QDRANT_URL,
                    api_key=self.config.QDRANT_API_KEY,
                    timeout=5.0
                )
                # Test connection
                client.get_collections()
                logger.info("Connected to Qdrant Cloud.")
                return client
            except Exception as e:
                logger.warning(f"Failed to connect to Qdrant Cloud: {e}. Falling back to local.")

        # Fallback to local
        os.makedirs("data/qdrant_db", exist_ok=True)
        logger.info("Using local Qdrant database.")
        return QdrantClient(path="data/qdrant_db")

    def check_flash_crash_anomaly(self, query_vector, threshold=0.96):
        # Stub for flash-crash anomaly guard
        return False
