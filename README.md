# Cloud Scheduler Job Control

This project provides a simple web interface to see the status of a Google Cloud Scheduler job and to pause or resume it. It is a dependency-free Node.js server that renders a plain HTML page (no client-side JavaScript).

The page shows the job state (enabled, paused, ...), its schedule and time zone, the next run, and the time and result of the last run.

## Permissions

The service account the server runs as needs `cloudscheduler.jobs.get`, `cloudscheduler.jobs.pause` and `cloudscheduler.jobs.resume` on the job.

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

