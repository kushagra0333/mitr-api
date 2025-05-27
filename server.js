import express from 'express';
import mongoose from 'mongoose';
import bodyParser from 'body-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import Coordinate from './coordinate.js'; // Ensure this is your Mongoose model

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['MONGODB_URI', 'PORT', 'API_KEY'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Error: Missing required environment variable ${envVar}`);
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Enhanced security middleware
app.use((req, res, next) => {
  // Basic API key validation (optional)
  if (req.path.startsWith('/api') && !req.path.includes('/status')) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    }
  }
  next();
});

// Device state tracking with improved data structure
const deviceStates = new Map();

// Enhanced MongoDB Connection with retry logic
const connectDB = async (retries = 5, interval = 5000) => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
    });
    console.log('MongoDB connected successfully');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    if (retries > 0) {
      console.log(`Retrying connection (${retries} attempts left)...`);
      await new Promise(resolve => setTimeout(resolve, interval));
      return connectDB(retries - 1, interval);
    }
    console.error('Failed to connect to MongoDB after multiple attempts');
    process.exit(1);
  }
};

// Connect to database
await connectDB();

// API Routes with improved error handling

/**
 * @route POST /api/device/trigger
 * @description Activate a device for data collection
 * @access Protected (API key required)
 */
app.post('/api/device/trigger', (req, res) => {
  try {
    const { deviceId } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({ 
        error: 'Device ID is required',
        code: 'DEVICE_ID_REQUIRED'
      });
    }

    // Set device to triggered state (active for 5 minutes)
    deviceStates.set(deviceId, {
      triggered: true,
      expires: Date.now() + 30000000, // 5 minutes from now
      lastActive: new Date()
    });

    console.log(`Device ${deviceId} triggered and ready for data`);
    res.json({ 
      message: 'Device triggered successfully', 
      status: 'active',
      expiresIn: 30000000
    });
  } catch (err) {
    console.error('Trigger error:', err);
    res.status(500).json({ 
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * @route POST /api/device/data
 * @description Receive location data from device
 * @access Protected (Device must be triggered)
 */
app.post('/api/device/data', async (req, res) => {
  try {
    const { deviceId, latitude, longitude } = req.body;
    
    // Validate input
    if (!deviceId || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ 
        error: 'Device ID, latitude and longitude are required',
        code: 'INVALID_INPUT'
      });
    }

    // Validate coordinates
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return res.status(400).json({
        error: 'Invalid coordinates',
        code: 'INVALID_COORDINATES'
      });
    }

    // Check device state
    const deviceState = deviceStates.get(deviceId);
    if (!deviceState?.triggered || deviceState.expires < Date.now()) {
      return res.status(403).json({ 
        error: 'Device not triggered or trigger expired',
        code: 'DEVICE_NOT_ACTIVE',
        solution: 'Send trigger request first'
      });
    }

    // Update last active time
    deviceState.lastActive = new Date();

    // Save to database
    const newCoordinate = new Coordinate({
      latitude,
      longitude,
      deviceId,
      timestamp: new Date()
    });

    const savedCoordinate = await newCoordinate.save();
    
    res.status(201).json({
      ...savedCoordinate.toJSON(),
      remainingTime: deviceState.expires - Date.now()
    });
  } catch (err) {
    console.error('Data submission error:', err);
    res.status(500).json({ 
      error: err.message,
      code: 'DATABASE_ERROR'
    });
  }
});

/**
 * @route GET /api/device/status/:deviceId
 * @description Check device trigger status
 * @access Public
 */
app.get('/api/device/status/:deviceId', (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const deviceState = deviceStates.get(deviceId);
    
    if (!deviceState) {
      return res.json({ 
        triggered: false, 
        message: 'Device not triggered',
        code: 'DEVICE_INACTIVE'
      });
    }
    
    const isActive = deviceState.triggered && deviceState.expires > Date.now();
    res.json({ 
      triggered: isActive,
      expiresIn: isActive ? deviceState.expires - Date.now() : 0,
      lastActive: deviceState.lastActive,
      code: isActive ? 'DEVICE_ACTIVE' : 'DEVICE_EXPIRED'
    });
  } catch (err) {
    console.error('Status check error:', err);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * @route GET /api/device/data/:deviceId
 * @description Get all coordinates for a device
 * @access Protected (Device must be triggered)
 */
app.get('/api/device/data/:deviceId', async (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const deviceState = deviceStates.get(deviceId);
    
    // Check if device is triggered or expired
    if (!deviceState?.triggered || deviceState.expires < Date.now()) {
      return res.status(403).json({ 
        error: 'Device not triggered or trigger expired',
        code: 'DEVICE_NOT_ACTIVE',
        solution: 'Send trigger request first'
      });
    }

    // Fetch coordinates for the device from the database
    const coordinates = await Coordinate.find({ deviceId })
      .sort({ timestamp: -1 })
      .lean(); // Return plain JS objects
    
    if (coordinates.length === 0) {
      return res.status(404).json({ 
        message: 'No data found for this device',
        code: 'NO_DATA'
      });
    }

    res.json({
      deviceId,
      count: coordinates.length,
      coordinates,
      remainingTime: deviceState.expires - Date.now() // Time remaining for the trigger
    });
  } catch (err) {
    console.error('Data fetch error:', err);
    res.status(500).json({
      error: err.message,
      code: 'DATABASE_ERROR'
    });
  }
});

// Enhanced cleanup of expired triggers
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [deviceId, state] of deviceStates.entries()) {
    if (state.expires < now) {
      deviceStates.delete(deviceId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`Cleaned up ${cleanedCount} expired triggers`);
  }
}, 60000); // Run every minute

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date(),
    dbState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Device Tracking API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  mongoose.connection.close(() => {
    console.log('MongoDB connection closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  mongoose.connection.close(() => {
    console.log('MongoDB connection closed');
    process.exit(0);
  });
});
