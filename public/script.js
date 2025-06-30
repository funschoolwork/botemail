const terminal = document.getElementById('terminal');
const socket = io();
const subscribeForm = document.getElementById('subscribe-form');
const subscribeButton = document.getElementById('subscribe-button');
const subscribeMessage = document.getElementById('subscribe-message');
const verificationPopup = document.getElementById('verification-popup');
const verificationEmail = document.getElementById('verification-email');
const resendButton = document.getElementById('resend-button');
const subscribePopup = document.getElementById('subscribe-popup');
const itemForm = document.getElementById('item-selection-form');
const popupEmail = document.getElementById('popup-email');
const errorMessage = document.getElementById('error-message');
const itemListContainer = document.getElementById('item-list-container');

let currentEmail = '';
let verificationTimer = null;

socket.on('log', msg => {
  terminal.textContent += msg + '\n';
  terminal.scrollTop = terminal.scrollHeight;
});

subscribeForm.onsubmit = async function(e) {
  e.preventDefault();
  const email = subscribeForm.querySelector('input[name="email"]').value.trim();
  if (!email) {
    showMessage('Email cannot be empty.', 'error');
    return;
  }

  currentEmail = email;
  subscribeButton.disabled = true;
  subscribeButton.textContent = 'Sending...';

  try {
    const response = await fetch('/request-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    
    const result = await response.json();
    showMessage(result.message, result.success ? 'success' : 'error');
    
    if (result.success) {
      verificationEmail.textContent = email;
      verificationPopup.style.display = 'block';
      startVerificationTimer();
    }
  } catch (err) {
    showMessage('Error sending verification request.', 'error');
    console.error('Error:', err);
  } finally {
    subscribeButton.disabled = false;
    subscribeButton.textContent = 'Subscribe';
  }
};

resendButton.onclick = async function() {
  resendButton.disabled = true;
  resendButton.textContent = 'Sending...';
  
  try {
    const response = await fetch('/request-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentEmail })
    });
    
    const result = await response.json();
    if (result.success) {
      showMessage('New verification email sent!', 'success', verificationPopup);
      startVerificationTimer();
    } else {
      showMessage(result.message || 'Failed to resend.', 'error', verificationPopup);
    }
  } catch (err) {
    showMessage('Error resending verification.', 'error', verificationPopup);
    console.error('Error:', err);
  } finally {
    resendButton.disabled = false;
    resendButton.textContent = 'Resend Verification';
  }
};

itemForm.onsubmit = async function(e) {
  e.preventDefault();
  const email = popupEmail.value;
  const itemCheckboxes = document.querySelectorAll('input[name="items"]:checked');
  
  if (itemCheckboxes.length === 0) {
    showError('Please select at least one item.');
    return;
  }

  const items = Array.from(itemCheckboxes).map(cb => cb.value);
  
  try {
    const response = await fetch('/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, items })
    });
    
    const result = await response.json();
    if (result.success) {
      subscribePopup.style.display = 'none';
      verificationPopup.style.display = 'none';
      showMessage('Successfully subscribed! You will now receive notifications.', 'success');
    } else {
      showError(result.message || 'Subscription failed.');
    }
  } catch (err) {
    showError('Error completing subscription.');
    console.error('Error:', err);
  }
};

function showMessage(text, type, container = subscribeForm) {
  const msgElement = container.querySelector('.message') || subscribeMessage;
  msgElement.textContent = text;
  msgElement.className = 'message ' + type;
  msgElement.style.display = 'block';
}

function showError(text) {
  errorMessage.textContent = text;
  errorMessage.style.display = 'block';
  setTimeout(() => {
    errorMessage.style.display = 'none';
  }, 5000);
}

function startVerificationTimer() {
  if (verificationTimer) {
    clearInterval(verificationTimer);
  }
  
  verificationTimer = setInterval(async () => {
    try {
      const response = await fetch('/check-verification?email=' + encodeURIComponent(currentEmail));
      const result = await response.json();
      
      if (result.verified) {
        clearInterval(verificationTimer);
        verificationPopup.style.display = 'none';
        popupEmail.value = currentEmail;
        subscribePopup.style.display = 'block';
        
        if (itemListContainer.textContent.includes('Loading')) {
          const response = await fetch('/refresh-items');
          const data = await response.json();
          const items = Object.values(data).filter(item => item && item.item_id && typeof item.item_id === 'string');
          
          itemListContainer.innerHTML = items.map(item => 
            `<label><input type="checkbox" name="items" value="${item.item_id}"> ${item.display_name || item.item_id}</label>`
          ).join('');
        }
      }
    } catch (err) {
      console.error('Error checking verification:', err);
    }
  }, 5000);
}

[verificationPopup, subscribePopup].forEach(popup => {
  popup.addEventListener('click', function(e) {
    if (e.target === popup) {
      popup.style.display = 'none';
      if (verificationTimer) {
        clearInterval(verificationTimer);
      }
    }
  });
});

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('verified') && urlParams.get('email')) {
  currentEmail = urlParams.get('email');
  popupEmail.value = currentEmail;
  subscribePopup.style.display = 'block';
} else if (urlParams.get('subscribed')) {
  showMessage('Successfully subscribed!', 'success');
} else if (urlParams.get('unsubscribed')) {
  showMessage('Successfully unsubscribed.', 'success');
}

if (itemListContainer.textContent.includes('Loading')) {
  setTimeout(() => {
    fetch('/refresh-items').then(() => window.location.reload());
  }, 3000);
}