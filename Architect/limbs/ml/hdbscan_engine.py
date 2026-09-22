from sklearn.decomposition import IncrementalPCA
import hdbscan
import numpy as np

class HDBSCANEngine:
    def __init__(self):
        self.ipca = IncrementalPCA(n_components=2)
        self.clusterer = hdbscan.HDBSCAN(min_cluster_size=5, min_samples=3)

    def fit_predict(self, data):
        """Incremental PCA (2D) + HDBSCAN clustering."""
        if len(data) < 5:
            return np.array([-1] * len(data))

        reduced_data = self.ipca.partial_fit(data).transform(data)
        labels = self.clusterer.fit_predict(reduced_data)
        return labels
