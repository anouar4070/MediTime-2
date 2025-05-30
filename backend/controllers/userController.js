import validator from "validator";
import bcrypt from "bcrypt";
import userModel from "../models/userModel.js";
import doctorModel from "../models/doctorModel.js";
import jwt from "jsonwebtoken";
import { v2 as cloudinary } from "cloudinary";
import appointmentModel from "../models/appointmentModel.js";
import Stripe from "stripe";

// API to register User
const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name | !email | !password) {
      return res.json({ success: false, message: "Missing Details!" });
    }
    // Validation email format
    if (!validator.isEmail(email)) {
      return res.json({ success: false, message: "Enter  a valid Email!" });
    }
    // Validation strong password
    if (password.length < 8) {
      return res.json({ success: false, message: "Enter a strong password" });
    }
    // Hashing user password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const userData = {
      name,
      email,
      password: hashedPassword,
    };
    const newUser = new userModel(userData);
    const user = await newUser.save();

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    res.json({ success: true, token });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

//API for user login
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await userModel.findOne({ email });

    if (!user) {
      return res.json({ success: false, message: "User does not exist !" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (isMatch) {
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
      res.json({ success: true, token });
    } else {
      res.json({ success: false, message: "Invalid Credentials !" });
    }
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

//Api to get User profile data
const getProfile = async (req, res) => {
  try {
    const { userId } = req.body;
    const userData = await userModel.findById(userId).select("-password");
    res.json({ success: true, userData });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

//API to update user profile
const updateProfile = async (req, res) => {
  try {
    const { userId, name, phone, address, dob, gender } = req.body;
    const imageFile = req.file;

    if (!name || !phone || !address || !dob || !gender) {
      return res.json({ success: false, message: "Missing Data !" });
    }

    await userModel.findByIdAndUpdate(userId, {
      name,
      phone,
      address: JSON.parse(address),
      dob,
      gender,
    });

    if (imageFile) {
      //Upload image to Cloudinary
      const imageUpload = await cloudinary.uploader.upload(imageFile.path, {
        resource_type: "image",
      });
      const imageURL = imageUpload.secure_url;

      await userModel.findByIdAndUpdate(userId, { image: imageURL });
    }

    res.json({ success: true, message: "Profile updated !" });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

//API to book appointment
const bookAppointment = async (req, res) => {
  try {
    const { userId, docId, slotDate, slotTime } = req.body;

    const docData = await doctorModel.findById(docId).select("-password");

    if (!docData.available) {
      return res.json({ success: false, message: "Doctor not available !" });
    }

    let slots_booked = docData.slots_booked;

    //*** Checking for slot availability ***/
    if (slots_booked[slotDate]) {
      if (slots_booked[slotDate].includes(slotTime)) {
        return res.json({ success: false, message: "Slot not available !" });
      } else {
        slots_booked[slotDate].push(slotTime);
      }
    } else {
      slots_booked[slotDate] = [];
      slots_booked[slotDate].push(slotTime);
    }

    const userData = await userModel.findById(userId).select("-password");

    // Remove the 'slots_booked' property from docData to exclude it from the appointment data,
    // while keeping the updated slots_booked intact for the doctorModel update.
    delete docData.slots_booked;

    const appointmentData = {
      userId,
      docId,
      userData,
      docData,
      amount: docData.fees,
      slotTime,
      slotDate,
      date: Date.now(),
    };

    const newAppointment = new appointmentModel(appointmentData);
    await newAppointment.save();

    //Save new slots data in docData
    await doctorModel.findByIdAndUpdate(docId, { slots_booked });
    res.json({ success: true, message: "Appointment booked" });
  } catch (error) {
    console.log(error);

    res.json({ success: false, message: error.message });
  }
};

// API to get user appointments for FrontEnd 'My-appointment' page
const listAppointment = async (req, res) => {
  try {
    const { userId } = req.body;
    const appointments = await appointmentModel.find({ userId });
    res.json({ success: true, appointments });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

//API to cancel appointment
const cancelAppointment = async (req, res) => {
  try {
    const { userId, appointmentId } = req.body;
    const appointmentData = await appointmentModel.findById(appointmentId);

    //Verify appointment user
    if (appointmentData.userId !== userId) {
      return res.json({ success: false, message: "Unauthorized action !" });
    }

    await appointmentModel.findByIdAndUpdate(appointmentId, {
      cancelled: true,
    });

    //Releasing doctor slot
    const { docId, slotDate, slotTime } = appointmentData;
    const doctorData = await doctorModel.findById(docId);
    let slots_booked = doctorData.slots_booked;
    slots_booked[slotDate] = slots_booked[slotDate].filter(
      (e) => e !== slotTime
    );
    await doctorModel.findByIdAndUpdate(docId, { slots_booked });
    res.json({ success: true, message: "Appointment Cancelled !" });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

const stripePayInstance = new Stripe(process.env.STRIPE_SECRET_KEY);

//* *** API to make payment of appointment using Stripe ***

const paymentStripe = async (req, res) => {
  try {
    const { appointmentId } = req.body;
    const appointmentData = await appointmentModel.findById(appointmentId);
    if (!appointmentData || appointmentData.cancelled) {
      
      return res.json({
        success: false,
        message: "Appointment Cancelled or Not Found",
      });
    }

    //creating options for Stripe Payment

    // const options = {
    //   amount: appointmentData.amount * 100,
    //   currency: process.env.CURRENCY,
    //   receipt: appointmentId,
    // };
    
    const options = {
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
      mode: "payment",

      line_items: [
        {
          price_data: {    
            currency: "usd",
            unit_amount: (appointmentData.docData.fees * 100),
            product_data: {
              name: `Appointment with doctor ${appointmentData.docData.name} in ${appointmentData.slotDate} at ${appointmentData.slotTime}`
            },
          },
          quantity: 1, //A medical appointment is a single service => quantity: 1
        },
      ],
    };

    //creating of an order
    // const order = await stripePayInstance.orders.create(options);
    const order = await stripePayInstance.checkout.sessions.create(options);

    res.json({ success: true, order });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

//* API to verify Payment of Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const verifyStripe = async(req, res) => {
  try {
    const { id } =  req.body;
    const orderInfo = await stripe.checkout.sessions.retrieve(id)
    console.log(orderInfo);
    if (orderInfo.status === 'paid') {
      await appointmentModel.findByIdAndUpdate(orderInfo.payment_intent, {payment: true})
      res.json({success: true, message: "Payment done successfully"})
    }else{
      res.json({success: false, message: "Payment Failed!"})

    }

  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
}

/**
 * 
 */

export {
  registerUser,
  loginUser,
  getProfile,
  updateProfile,
  bookAppointment,
  listAppointment,
  cancelAppointment,
  paymentStripe,
  verifyStripe
};

//  slotBooked => object (to reserve date)
//  slotDate => day chosen by the client

// {
// "2025-02-14": ["10:00", "11:00", "12:00"]
// }

/**
 * docData = { 
doctorName: "dr. Amine",
speciality: "Dentist",
fees: 80,
slots_booked: ["10:00", "11:00", "12:00"]
}

docData = { 
doctorName: "dr. Salem",
speciality: "Dentist",
fees: 80,
slots_booked: ["10:00", "11:00", "12:00"]
}

docData = { 
doctorName: "dr. Anouar",
speciality: "Dentist",
fees: 80,
slots_booked: ["10:00", "11:00", "12:00"]
}
 */
