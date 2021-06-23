import mongoose from 'mongoose';
/**
* Blacklist interface 
*/
interface IBlacklist 
{
  ipAddress:string,
  description: string
}
/**
* Mongoose schema for blacklist Ip
*/
const blacklistSchema = new mongoose.Schema(
    {
        ipAddress: {
            type: String,
            required: true
        },
        description: {
            type: String
        }
    },
    {
        timestamps: true,
    }
)
const Blacklist = mongoose.model<IBlacklist & mongoose.Document>('Blacklist', blacklistSchema);
export default Blacklist;
