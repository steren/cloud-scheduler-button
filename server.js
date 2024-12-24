const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

// Get job name from environment variable
const jobName = process.env.JOB_NAME;
if (!jobName) {
  throw new Error('Environment variable JOB_NAME not set.');
}

// Metadata server endpoints
const metadataBaseUrl = 'http://metadata.google.internal/computeMetadata/v1/';
const metadataHeaders = { 'Metadata-Flavor': 'Google' };

// Function to get metadata from the server
async function getMetadata(path) {
  const options = {
    hostname: 'metadata.google.internal',
    path: `/computeMetadata/v1/${path}`,
    headers: metadataHeaders,
  };

  return new Promise((resolve, reject) => {
    const req = http.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`Error getting metadata: ${res.statusCode} - ${res.statusMessage}`));
        }
      });
    });
    req.on('error', (error) => {
      reject(new Error('Error requesting metadata: ' + error.message));
    });
    req.end();
  });
}

// Get project ID and location from metadata server
async function getProjectAndLocation() {
  try {
    const projectId = await getMetadata('project/project-id');
    const region = await getMetadata('instance/region'); // Returns in the format 'projects/PROJECT_NUMBER/regions/REGION'
    const location = region.split('/').pop
    return { projectId, location };
  } catch (error) {
    throw new Error('Error getting project ID and/or location from metadata server: ' + error.message);
  }
}

// Get token from metadata server
async function getTokenFromMetadataServer() {
  return new Promise((resolve, reject) => {
    const req = http.get(metadataBaseUrl + 'instance/service-accounts/default/token', { headers: metadataHeaders }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const tokenData = JSON.parse(data);
            resolve(tokenData.access_token);
          } catch (error) {
            reject(new Error('Error parsing token from metadata server: ' + error.message));
          }
        } else {
          reject(new Error(`Error getting token from metadata server: ${res.statusCode} - ${res.statusMessage}`));
        }
      });
    });
    req.on('error', (error) => {
      reject(new Error('Error requesting token from metadata server: ' + error.message));
    });
    req.end();
  });
}

// Main request handler
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname === '/') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.statusCode = 500;
        res.end('Error loading index.html');
      } else {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html');
        res.end(data);
      }
    });
  } else if (pathname === '/stop-job' && req.method === 'POST') {
    console.log('Received request to stop job.');
    console.log('Job stopping process initiated');

    try {
      // Get project ID and location from metadata server
      const { projectId, location } = await getProjectAndLocation();

      // Get the auth token from the metadata server
      const authToken = await getTokenFromMetadataServer();

      // Cloud Scheduler API endpoint
      const cloudSchedulerEndpoint = `https://cloudscheduler.googleapis.com/v1/projects/${projectId}/locations/${location}/jobs/${jobName}:pause`;

      console.log(`Pausing ${cloudSchedulerEndpoint}...`);

      const postOptions = {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      };

      const apiReq = https.request(cloudSchedulerEndpoint, postOptions, (apiRes) => {
        let apiData = '';
        apiRes.on('data', (chunk) => apiData += chunk);
        apiRes.on('end', () => {
          if (apiRes.statusCode === 200) {
            console.log(`Job ${jobName} paused successfully.`);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ message: `Job ${jobName} paused successfully.` }));
          } else {
            console.error(`Error pausing job: ${apiRes.statusCode} - ${apiRes.statusMessage}`);
            res.statusCode = apiRes.statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Failed to pause job.', details: apiData }));
          }
        });
      });

      apiReq.on('error', (error) => {
        console.error('Error making API request:', error);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Failed to pause job.', details: error.message }));
      });

      // Send an empty body as per the API docs for the pause endpoint
      apiReq.write(JSON.stringify({}));
      apiReq.end();

    } catch (error) {
      console.error('Error:', error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Failed to pause job.', details: error.message }));
    }
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
});

const port = process.env.PORT || 8080;

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});