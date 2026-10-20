async function getStackOverflowTitle(url) {
  // Extract the question ID from the URL using regex
  const match = url.match(/\/questions\/(\d+)/);
  if (!match) throw new Error("Invalid Stack Overflow URL");
  
  const questionId = match[1];
  const apiUrl = `https://stackexchange.com{questionId}?site=stackoverflow`;
  
  const response = await fetch(apiUrl);
  const data = await response.json();
  
  if (data.items && data.items.length > 0) {
    return data.items[0].title;
  }
  throw new Error("Question not found");
}

// Example usage:
getStackOverflowTitle("https://stackoverflow.com/questions/11299354/should-a-restful-get-response-return-a-resources-id")
  .then(title => console.log(title))
  .catch(err => console.error(err));