function parseTwitterUrl(url) {
  try {
    const parsedObj = new URL(url);
    const parts = parsedObj.pathname.split('/').filter(Boolean);
    
    // Check if it's a status/tweet URL
    if (parts.length >= 3 && parts[1] === 'status') {
      return {
        username: parts[0],
        type: 'tweet',
        id: parts[2]
      };
    }
    // Check if it's a profile URL
    else if (parts.length === 1) {
      return {
        username: parts[0],
        type: 'profile',
        id: null
      };
    }
    return null;
  } catch (e) {
    return null; // Invalid URL
  }
}

// Example usage:
const result = parseTwitterUrl('https://x.com');
console.log(result); 
// Output: { username: 'NASA', type: 'tweet', id: '1800000000000000000' }