// youtube URL can be shorted as: youtu.be/T-HZHO_PQPY

async function getYouTubeTitle(videoUrl) {
  const oEmbedUrl = `https://youtube.com{encodeURIComponent(videoUrl)}`;
  
  try {
    const response = await fetch(oEmbedUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.title;
  } catch (error) {
    console.error("Failed to fetch YouTube title:", error);
    return null;
  }
}

// Example usage:
const url = "https://youtube.com";
getYouTubeTitle(url).then(title => console.log("Video Title:", title));