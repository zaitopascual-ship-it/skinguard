from inference_sdk import InferenceHTTPClient

# Initialize the client with your private API key
client = InferenceHTTPClient(
    api_url="https://serverless.roboflow.com",
    api_key="vroGkKI7rmItWsL93dBh"
)

# Run inference on your model
result = client.infer("C:\Users\aaron\Desktop\DESKTOP\SkinGuard_3.0_CustomTrainedData\test_image.jpg", model_id="skinguard_datasetsv1-2/3")

# Print the predictions
print(result)