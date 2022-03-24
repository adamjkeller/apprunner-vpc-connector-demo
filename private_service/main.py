#!/usr/bin/env python3

from fastapi import FastAPI, status
from fastapi.responses import JSONResponse
import requests
import os

app = FastAPI(
    title="App Runner Private ECS Service VPC Demo",
    description="Demo API that demonstrates a connection from an app runner service to a private service running in a VPC in an ECS Cluster",
    version="1.0.0",
)


def return_metadata():
    resp = requests.get(os.getenv("ECS_CONTAINER_METADATA_URI_V4") + "/task").json()
    return {
        "TaskArn": resp.get("TaskARN"),
        "Cluster": resp.get("Cluster"),
        "LaunchType": resp.get("LaunchType"),
        "ServiceName": resp.get("Containers")[0]["Name"],
        "IpAddress": resp.get("Containers")[0]["Networks"][0]["IPv4Addresses"][0],
    }


@app.get("/health")
def health():
    return JSONResponse(status_code=status.HTTP_200_OK, content={"Status": "Healthy"})


@app.get("/")
def root():
    task_metadata = return_metadata()
    return JSONResponse(status_code=status.HTTP_200_OK, content=task_metadata)


if __name__ == "__main__":
    import uvicorn

    print("Starting up on host 0.0.0.0:8080...")
    uvicorn.run("main:app", host="0.0.0.0", port=8080, log_level="debug")
