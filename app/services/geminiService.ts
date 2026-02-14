
import { GoogleGenAI, Type } from "@google/genai";
import { IMUData } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzeMovement = async (dataBuffer: IMUData[]) => {
  try {
    const formattedData = dataBuffer.map(d => ({
      t: d.timestamp,
      o: [d.orientation.alpha, d.orientation.beta, d.orientation.gamma],
      a: [d.acceleration.x, d.acceleration.y, d.acceleration.z]
    }));

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Analyze the following IMU data sequence (10 samples). 
      Detect the type of physical movement (e.g., stationary, walking, rotating, tilting).
      Provide a concise 1-sentence observation.
      
      Data: ${JSON.stringify(formattedData)}`,
      config: {
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    return response.text || "No insights available.";
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return "Error generating insights.";
  }
};
