from qdrant_client import QdrantClient
from qdrant_client.models import Distance, FieldCondition, Filter, MatchValue, PointStruct, VectorParams
import logging
import os

logger = logging.getLogger(__name__)

# Same collection and vector width as the Node learning store
# (`src/learning/qdrantKnowledge.ts`). Both clients share points only when
# they dial the same QDRANT_URL.
KNOWLEDGE_COLLECTION = "knowledge_library"
KNOWLEDGE_VECTOR_SIZE = 64

class QdrantMemoryEngine:
    def __init__(self, config):
        self.config = config
        self.client = self._initialize_client()

    def _initialize_client(self):
        url = (getattr(self.config, "QDRANT_URL", "") or "").strip()
        if url:
            try:
                kwargs = {"url": url, "timeout": 5.0}
                api_key = (getattr(self.config, "QDRANT_API_KEY", "") or "").strip()
                if api_key:
                    kwargs["api_key"] = api_key
                client = QdrantClient(**kwargs)
                client.get_collections()
                logger.info("Connected to Qdrant at %s.", url)
                return client
            except Exception as e:
                if not getattr(self.config, "QDRANT_USE_LOCAL_FALLBACK", True):
                    raise
                logger.warning("Failed to connect to Qdrant at %s: %s. Falling back to local.", url, e)

        os.makedirs("data/qdrant_db", exist_ok=True)
        logger.info("Using local Qdrant database.")
        return QdrantClient(path="data/qdrant_db")

    def ensure_knowledge_collection(self) -> None:
        existing = {collection.name for collection in self.client.get_collections().collections}
        if KNOWLEDGE_COLLECTION in existing:
            return
        self.client.create_collection(
            collection_name=KNOWLEDGE_COLLECTION,
            vectors_config=VectorParams(size=KNOWLEDGE_VECTOR_SIZE, distance=Distance.COSINE),
        )

    def upsert_knowledge(self, entries: list[dict]) -> None:
        """Write knowledge points. Each item needs point_id, vector (len 64) and payload."""
        self.ensure_knowledge_collection()
        points = []
        for entry in entries:
            vector = entry.get("vector")
            if not isinstance(vector, list) or len(vector) != KNOWLEDGE_VECTOR_SIZE:
                raise ValueError(f"knowledge vector must have length {KNOWLEDGE_VECTOR_SIZE}")
            points.append(PointStruct(id=entry["point_id"], vector=vector, payload=entry.get("payload") or {}))
        if points:
            self.client.upsert(collection_name=KNOWLEDGE_COLLECTION, points=points, wait=True)

    def search_knowledge(self, vector, limit=5, domain=None, algorithm_tag=None, include_corrections=True):
        self.ensure_knowledge_collection()
        must = []
        must_not = []
        if domain:
            must.append(FieldCondition(key="domain", match=MatchValue(value=domain)))
        if algorithm_tag:
            must.append(FieldCondition(key="algorithmTag", match=MatchValue(value=algorithm_tag)))
        if not include_corrections:
            must_not.append(FieldCondition(key="contentType", match=MatchValue(value="correction")))
        query_filter = Filter(must=must or None, must_not=must_not or None) if (must or must_not) else None
        return self.client.search(
            collection_name=KNOWLEDGE_COLLECTION,
            query_vector=vector,
            query_filter=query_filter,
            limit=limit,
            with_payload=True,
        )

    def check_flash_crash_anomaly(self, query_vector, threshold=0.96):
        # Stub for flash-crash anomaly guard
        return False
