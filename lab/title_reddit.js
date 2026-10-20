async function getRedditTitle(redditUrl) {
  try {
    // Clean URL and append .json extension
    const jsonUrl = redditUrl.split('?')[0].replace(/\/$/, "") + ".json";
    
    // Fetch data with a custom User-Agent to avoid rate limits
    const response = await fetch(jsonUrl, {
      headers: { 'User-Agent': 'javascript:title.extractor:v1.0' }
    });
    
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    
    const data = await response.json();
    
    // Extract title from the listing data structure
    const title = data[0].data.children[0].data.title;
    return title;
  } catch (error) {
    console.error("Failed to fetch Reddit title:", error);
    return null;
  }
}

// Usage
const url = "https://reddit.com";
getRedditTitle(url).then(title => console.log("Title:", title));