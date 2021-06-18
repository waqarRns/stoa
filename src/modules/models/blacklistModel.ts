import mongoose from 'mongoose';
/**
* Blacklist interface 
*/
interface IBlacklist 
{
  ipAddress:string
}
/**
* Mongoose schema for blacklist Ip
*/
const blacklistSchema = new mongoose.Schema(
    {
        ipAddress: {
            type: String
        }
    }
)
const Blacklist = mongoose.model<mongoose.Document>('Blacklist', blacklistSchema);
export default Blacklist;
