const axios = require('axios');
const cheerio = require('cheerio');

async function getMediumTitle(url) {
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const $ = cheerio.load(data);
    // Medium usually stores the main story title in an H1 tag
    const title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content');
    return title;
  } catch (error) {
    console.err('Error fetching the Medium link:', error.message);
  }
}

getMediumTitle('https://medium.com')
  .then(title => console.log('Title:', title));