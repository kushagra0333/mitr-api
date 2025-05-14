import mongoose from 'mongoose';

const CoordinateSchema = new mongoose.Schema({
  latitude: {
    type: Number,
    required: true,
  },
  longitude: {
    type: Number,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  deviceId: String,
});

const Coordinate = mongoose.model('Coordinate', CoordinateSchema);

export default Coordinate;