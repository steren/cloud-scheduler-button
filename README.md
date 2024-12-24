# Cloud Scheduler Job Control

This project provides a simple web interface to start and stop a Google Cloud Scheduler job. It includes a server-side component written in Node.js and a client-side component written in HTML and JavaScript.

## Environment Variables

Required: 

- `JOB_NAME`: The name of the Cloud Scheduler job to control

Optional:

- `REGION`: The region where the Cloud Scheduler job is located (optional, will use same location as where this code runs if not set)
- `PORT`: The port on which the server will run (default: 8080)

## Deploy to Cloud Run

```
gcloud run deploy --source . --allow-unauthenticated --set-env-vars JOB_NAME=your-job-name
```

