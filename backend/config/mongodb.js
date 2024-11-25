import mongoose from "mongoose";

const connectDB = async () => {
  mongoose.connection.on("connected", () => console.log("DataBase connected!"));
  await mongoose.connect(`${process.env.MONGODB_URI}/meditime`);
};

export default connectDB;
