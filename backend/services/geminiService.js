const { GoogleGenAI, Modality } = require("@google/genai");
const { cloudinary } = require("../config/cloudinary");
const Image = require("../models/Image");
const { AppError } = require("../middleware/errorHandler");
const logger = require("../config/logger");

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Upload image buffer to Cloudinary
 * @param {Buffer} imageBuffer - Image buffer to upload
 * @param {string} folder - Cloudinary folder path
 * @returns {Promise<string>} Cloudinary URL
 */
async function uploadToCloudinary(imageBuffer, folder) {
  try {
    const base64Image = imageBuffer.toString('base64');
    const result = await cloudinary.uploader.upload(`data:image/png;base64,${base64Image}`, {
      folder,
      resource_type: "image",
      transformation: [
        { quality: "auto:good" },
        { fetch_format: "auto" }
      ]
    });

    logger.info(`Image uploaded to Cloudinary`, {
      publicId: result.public_id,
      url: result.secure_url
    });

    return result.secure_url;
  } catch (error) {
    logger.error('Cloudinary upload error:', error);
    throw new AppError('Failed to upload image to cloud storage', 500);
  }
}

/**
 * Extract image data from Gemini API response
 * @param {Object} response - Gemini API response
 * @returns {string|null} Base64 image data or null
 */
function extractImageFromResponse(response) {
  if (!response.candidates?.[0]?.content?.parts) {
    return null;
  }

  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      return part.inlineData.data;
    }
  }

  return null;
}

/**
 * Generate image using Gemini AI
 * @param {string} prompt - Text prompt for image generation
 * @returns {Promise<string>} Generated image URL
 */
async function generateImage(prompt) {
  try {
    logger.info('Starting image generation with Gemini AI', { prompt: prompt.substring(0, 50) });

    const response = await genAI.models.generateContent({
      model: "gemini-2.0-flash-exp-image-generation",
      contents: prompt,
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
      },
    });

    const imageData = extractImageFromResponse(response);

    if (!imageData) {
      throw new AppError('Failed to generate image from AI service', 500);
    }

    // Upload to Cloudinary
    const imageUrl = await uploadToCloudinary(
      Buffer.from(imageData, 'base64'),
      "ai-image-studio/generated"
    );

    // Save to database
    const newImage = new Image({
      type: "generated",
      prompt,
      imagePath: imageUrl
    });
    await newImage.save();

    logger.info('Image generated and saved successfully', {
      imageId: newImage._id,
      imageUrl
    });

    return imageUrl;
  } catch (error) {
    logger.error('Image generation error:', error);

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Failed to generate image: ' + error.message, 500);
  }
}

/**
 * Modify image using Gemini AI
 * @param {string} prompt - Text prompt for image modification
 * @param {Buffer} imageBuffer - Original image buffer
 * @returns {Promise<string>} Modified image URL
 */
async function modifyImage(prompt, imageBuffer) {
  try {
    logger.info('Starting image modification with Gemini AI', { prompt: prompt.substring(0, 50) });

    // Convert buffer to base64 for Gemini API
    const base64Image = imageBuffer.toString('base64');

    // Create the content parts array with the image and prompt
    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType: "image/png"
      }
    };

    // Prepare the prompt for image modification
    const fullPrompt = `Modify this image according to the following instructions: ${prompt}`;

    const response = await genAI.models.generateContent({
      model: "gemini-2.0-flash-exp-image-generation",
      contents: [imagePart, fullPrompt],
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
      },
    });

    const imageData = extractImageFromResponse(response);

    if (!imageData) {
      throw new AppError('Failed to modify image from AI service', 500);
    }

    // Upload to Cloudinary
    const imageUrl = await uploadToCloudinary(
      Buffer.from(imageData, 'base64'),
      "ai-image-studio/modified"
    );

    // Save to database
    const newImage = new Image({
      type: "modified",
      prompt,
      imagePath: imageUrl
    });
    await newImage.save();

    logger.info('Image modified and saved successfully', {
      imageId: newImage._id,
      imageUrl
    });

    return imageUrl;
  } catch (error) {
    logger.error('Image modification error:', error);

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Failed to modify image: ' + error.message, 500);
  }
}

/**
 * Delete image from both database and Cloudinary
 * @param {string} imageId - MongoDB image ID
 * @returns {Promise<Object>} Deletion result
 */
async function deleteImage(imageId) {
  try {
    logger.info('Starting image deletion', { imageId });

    // Find the image in the database
    const image = await Image.findById(imageId);
    if (!image) {
      throw new AppError('Image not found', 404);
    }

    // Extract the Cloudinary public ID from the URL
    const urlParts = image.imagePath.split('/');
    const uploadIndex = urlParts.indexOf('upload');

    if (uploadIndex === -1) {
      throw new AppError('Invalid Cloudinary URL format', 400);
    }

    // Get the filename including the folder path after the /upload/ part
    const publicIdWithExtension = urlParts.slice(uploadIndex + 1).join('/');
    // Remove file extension to get the public ID
    const publicId = publicIdWithExtension.substring(0, publicIdWithExtension.lastIndexOf('.'));

    // Delete the image from Cloudinary
    await cloudinary.uploader.destroy(publicId);

    logger.info('Image deleted from Cloudinary', { publicId });

    // Delete the image from the database
    await Image.findByIdAndDelete(imageId);

    logger.info('Image deleted from database', { imageId });

    return { success: true, id: imageId };
  } catch (error) {
    logger.error('Image deletion error:', error);

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Failed to delete image: ' + error.message, 500);
  }
}

module.exports = {
  generateImage,
  modifyImage,
  deleteImage
};
