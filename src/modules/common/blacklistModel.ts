import mongoose from 'mongoose';
/**
* Mongoose schema for blacklist Ip
*/
const Blacklist = new mongoose.Schema(
    {
        ipAddress: {
            type: String
        }
    }
)
export default mongoose.model<mongoose.Document>('Blacklist', Blacklist);
