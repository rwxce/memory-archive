// Example URLs
const profileUrl = "https://linkedin.com";
const jobUrl = "https://linkedin.com";

// Extract name from profile URL
const profileMatch = profileUrl.match(/\/in\/([\w-]+)/);
const profileName = profileMatch ? profileMatch[1].replace(/-/g, ' ') : null; 
console.log(profileName); // "john doe 123456"

// Extract title from job URL
const jobMatch = jobUrl.match(/\/jobs\/view\/([\w-]+)/);
const jobTitle = jobMatch ? jobMatch[1].replace(/-/g, ' ') : null;
console.log(jobTitle); // "software engineer at techcorp 398472"