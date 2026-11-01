// ---------- Page switching (with fade animation via CSS classes) ----------
function showAlertPage() {
  document.getElementById('home').classList.remove('active');
  document.getElementById('alertPage').classList.add('active');
}
function showHomePage() {
  document.getElementById('alertPage').classList.remove('active');
  document.getElementById('home').classList.add('active');
}

// ---------- Photo capture preview ----------
const photoInput = document.getElementById('photoInput');
const photoPreview = document.getElementById('photoPreview');

photoInput.addEventListener('change', () => {
  const file = photoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    photoPreview.src = e.target.result;
    photoPreview.hidden = false;
  };
  reader.readAsDataURL(file);
});

// ---------- GPS tracker ----------
const gpsBtn = document.getElementById('gpsBtn');
const locationInput = document.getElementById('location');
const gpsStatus = document.getElementById('gpsStatus');
const mapFrame = document.getElementById('mapFrame');
const GOOGLE_MAPS_API_KEY = 'AIzaSyD6xdcWb4GyqMrIGxHiBLlBZqwtgBXHh-o';

function updateMapLocation(lat, lng) {
  const mapUrl = `https://www.google.com/maps?q=${lat},${lng}&z=16&output=embed`;
  mapFrame.src = mapUrl;
}

function buildReadableAddress(data) {
  const results = data?.results || [];
  const result = results[0];
  const components = result?.address_components || [];

  const getAddressPart = (type) => {
    const match = components.find((component) => component.types.includes(type));
    return match ? match.long_name : '';
  };

  const flatNumber = getAddressPart('subpremise');
  const streetNumber = getAddressPart('street_number');
  const route = getAddressPart('route');
  const building = getAddressPart('premise');
  const colony = getAddressPart('neighborhood') || getAddressPart('sublocality_level_1') || getAddressPart('sublocality');
  const area = getAddressPart('sublocality_level_2') || getAddressPart('postal_town') || getAddressPart('locality');
  const city = getAddressPart('administrative_area_level_2') || getAddressPart('locality');
  const state = getAddressPart('administrative_area_level_1');
  const pincode = getAddressPart('postal_code');

  const addressLine1 = [
    flatNumber ? `Flat No. ${flatNumber}` : '',
    building ? `Building ${building}` : '',
    [streetNumber, route].filter(Boolean).join(' ')
  ].filter(Boolean).join(', ');

  const addressLine2 = [colony, area].filter(Boolean).join(', ');
  const addressLine3 = [city, state].filter(Boolean).join(', ');
  const addressLine4 = pincode ? `${state ? '' : city ? '' : ''}${pincode}` : '';

  const addressParts = [
    addressLine1,
    addressLine2,
    addressLine3,
    addressLine4
  ].filter(Boolean);

  if (addressParts.length > 0) {
    return addressParts.join(', ');
  }

  return result?.formatted_address || 'Current location detected';
}

gpsBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    gpsStatus.textContent = 'GPS is not supported on this device/browser.';
    return;
  }
  gpsBtn.classList.add('locating');
  gpsStatus.textContent = 'Detecting your location...';

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;

      updateMapLocation(lat, lng);

      if (!GOOGLE_MAPS_API_KEY || GOOGLE_MAPS_API_KEY === 'YOUR_GOOGLE_MAPS_API_KEY') {
        locationInput.value = 'Please add your Google Maps API key';
        gpsStatus.textContent = 'Add your Google Maps API key to enable exact address lookup.';
        gpsBtn.classList.remove('locating');
        return;
      }

      fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`)
        .then((response) => response.json())
        .then((data) => {
          if (data.status === 'OK' && data.results && data.results.length > 0) {
            const address = buildReadableAddress(data);
            locationInput.value = address;
            gpsStatus.textContent = `Location found: ${address}`;
          } else {
            locationInput.value = 'Current location detected';
            gpsStatus.textContent = 'Location found near your current area.';
          }
        })
        .catch(() => {
          locationInput.value = 'Current location detected';
          gpsStatus.textContent = 'Location found near your current area.';
        })
        .finally(() => {
          gpsBtn.classList.remove('locating');
        });
    },
    (error) => {
      gpsBtn.classList.remove('locating');
      gpsStatus.textContent = 'Could not get location: ' + error.message;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ---------- Form submit ----------
document.getElementById('alertForm').addEventListener('submit', (e) => {
  e.preventDefault();
  document.getElementById('successMsg').hidden = false;
  // Replace this with a real API call to your backend/hospital system:
  // fetch('/api/alerts', { method: 'POST', body: JSON.stringify({...}) })
});