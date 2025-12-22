
const axios = require('axios');

async function test() {
  try {
    const url = 'http://localhost:4000/api/public/journal/c4b07fa1-5d0b-455b-90e5-f7cf69496b16';
    console.log('Fetching:', url);
    const res = await axios.get(url);
    console.log('Status:', res.status);
    console.log('Data Type:', Array.isArray(res.data) ? 'Array' : typeof res.data);
    console.log('Data Length:', Array.isArray(res.data) ? res.data.length : 'N/A');
    if (Array.isArray(res.data) && res.data.length > 0) {
      console.log('First Item:', JSON.stringify(res.data[0], null, 2));
    }
  } catch (e) {
    console.error('Error:', e.message);
    if (e.response) {
      console.error('Response Status:', e.response.status);
      console.error('Response Data:', e.response.data);
    }
  }
}

test();
