import torch
import torch.nn as nn
import os

class RegimeModel(nn.Module):
    def __init__(self):
        super().__init__()
        # Dummy 16d input to 4d output (4 regimes)
        self.fc = nn.Linear(16, 4)
        self.softmax = nn.Softmax(dim=1)

    def forward(self, x):
        return self.softmax(self.fc(x))

def export_model():
    model = RegimeModel()
    model.eval()

    # Dummy input (batch_size=1, features=16)
    dummy_input = torch.randn(1, 16)

    os.makedirs("weights", exist_ok=True)
    onnx_path = "weights/omega_regime_16d.onnx"

    torch.onnx.export(
        model,
        dummy_input,
        onnx_path,
        export_params=True,
        opset_version=14,
        do_constant_folding=True,
        input_names=["market_features_16d"],
        output_names=["regime_probabilities"],
        dynamic_axes={
            "market_features_16d": {0: "batch_size"},
            "regime_probabilities": {0: "batch_size"}
        }
    )
    print(f"Exported model to {onnx_path}")

if __name__ == "__main__":
    export_model()
