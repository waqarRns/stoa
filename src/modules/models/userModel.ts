import mongoose from 'mongoose';
/**
* User interface 
*/
interface IUser 
{
  name: string,
  email:string,
  password:string,
}
/**
* Mongoose schema for Admin user 
*/
const userSchema = new mongoose.Schema(
    {
        name: {
          type: String,
          required: true,
        },
        email: {
          type: String,
          required: true,
          unique: true,
        },
        password: {
          type: String,
          required: true,
        },
      },
      {
        timestamps: true,
      }
)
const User = mongoose.model<IUser & mongoose.Document>('User', userSchema);
export default User;