const checkButton = document.getElementById("checkButton");
const studentIdInput = document.getElementById("studentId");
const loader = document.getElementById("loader");
const result = document.getElementById("result");
const overlay = document.getElementById("feedbackOverlay");
const icon = document.getElementById("feedbackIcon");

// Web Audio API helper for sound synthesis
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playSound(type) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();
  
  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  
  if (type === 'success') {
    // "Ting-tong" like 7-11
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
    osc.frequency.setValueAtTime(659.25, audioCtx.currentTime + 0.2); // E5
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(1, audioCtx.currentTime + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.5);
  } else if (type === 'error') {
    // "Buzzer"
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, audioCtx.currentTime);
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.5);
  } else if (type === 'already') {
    // Soft notification
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    osc.frequency.setValueAtTime(440, audioCtx.currentTime + 0.1);
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.3);
  }
}

function showFeedback(type) {
  overlay.classList.add('show');
  icon.classList.remove('animate-pop');
  
  if (type === 'success') {
    icon.textContent = '✅';
  } else if (type === 'error') {
    icon.textContent = '❌';
  } else if (type === 'already') {
    icon.textContent = '🟤';
  }
  
  // Trigger reflow
  void icon.offsetWidth;
  icon.classList.add('animate-pop');
  
  setTimeout(() => {
    overlay.classList.remove('show');
  }, 1200);
}

async function checkIn() {
  const id = studentIdInput.value.trim();

  if (!id) {
    result.textContent = "กรุณากรอกรหัสนักเรียน";
    playSound('error');
    showFeedback('error');
    return;
  }

  checkButton.disabled = true;
  loader.hidden = false;
  result.textContent = "";

  try {
    const isNFC = id.length > 6 || isNaN(Number(id));
    const endpoint = isNFC ? "/api/check/nfc" : "/api/check";
    const payload = isNFC ? { uid: id } : { id };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    result.textContent = data.message;
    
    if (response.ok) {
      if (data.alreadyCheckedIn) {
        playSound('already');
        showFeedback('already');
      } else {
        playSound('success');
        showFeedback('success');
      }
    } else {
      playSound('error');
      showFeedback('error');
    }
    
    studentIdInput.value = '';
    studentIdInput.focus();
    
  } catch (error) {
    result.textContent = "❌ ต่อเซิร์ฟเวอร์ไม่ได้";
    playSound('error');
    showFeedback('error');
  } finally {
    checkButton.disabled = false;
    loader.hidden = true;
  }
}

checkButton.addEventListener("click", checkIn);
studentIdInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    checkIn();
  }
});

// Web NFC Support (Mobile Browser)
const webNfcButton = document.getElementById("webNfcButton");
if ("NDEFReader" in window) {
  webNfcButton.style.display = "inline-flex";
  webNfcButton.addEventListener("click", async () => {
    try {
      const ndef = new NDEFReader();
      await ndef.scan();
      result.textContent = "📱 นำบัตรมาแตะที่หลังมือถือ...";
      
      ndef.addEventListener("reading", ({ message, serialNumber }) => {
        if (serialNumber) {
          studentIdInput.value = serialNumber.replace(/:/g, ""); // Clean up colons
          checkIn();
        }
      });
      
      ndef.addEventListener("readingerror", () => {
        result.textContent = "❌ อ่านบัตรไม่สำเร็จ ลองใหม่อีกครั้ง";
        playSound("error");
        showFeedback("error");
      });
    } catch (error) {
      result.textContent = "❌ ไม่สามารถเปิด NFC ได้: " + error.message;
      playSound("error");
    }
  });
}

// QR Scanner Logic
const openQrScannerBtn = document.getElementById('openQrScannerBtn');
const qrScannerModal = document.getElementById('qrScannerModal');
const closeQrScannerBtn = document.getElementById('closeQrScannerBtn');
const submitQrCodeBtn = document.getElementById('submitQrCodeBtn');
const qrStudentIdInput = document.getElementById('qrStudentIdInput');
const qrCodeInput = document.getElementById('qrCodeInput');

let html5QrcodeScanner = null;

if (openQrScannerBtn) {
  openQrScannerBtn.addEventListener('click', () => {
    // Pre-fill student ID if logged in or typed
    const currentId = studentIdInput.value.trim();
    if (currentId) {
      qrStudentIdInput.value = currentId;
    } else {
      const userStr = localStorage.getItem('nutcheck_user');
      if (userStr) {
        try {
          const user = JSON.parse(userStr);
          if (user.studentId) qrStudentIdInput.value = user.studentId;
        } catch(e) {}
      }
    }
    
    qrScannerModal.style.display = 'flex';
    qrCodeInput.value = '';
    qrCodeInput.focus();
    
    // Initialize Scanner
    if (typeof Html5QrcodeScanner !== 'undefined') {
      html5QrcodeScanner = new Html5QrcodeScanner(
        "qrReaderContainer",
        { fps: 10, qrbox: {width: 250, height: 250} },
        /* verbose= */ false);
        
      html5QrcodeScanner.render(onScanSuccess, onScanFailure);
    } else {
      document.getElementById("qrReaderContainer").innerHTML = "<p style='padding: 20px; color: red;'>ไม่สามารถโหลดตัวสแกนคิวอาร์โค้ดได้</p>";
    }
  });
}

function onScanSuccess(decodedText, decodedResult) {
  if (decodedText && decodedText.length === 6) {
    qrCodeInput.value = decodedText;
    if (qrStudentIdInput.value.trim()) {
      submitQrCodeBtn.click();
    }
  }
}

function onScanFailure(error) {
  // Ignore scan failures
}

function closeQrScanner() {
  qrScannerModal.style.display = 'none';
  if (html5QrcodeScanner) {
    html5QrcodeScanner.clear().catch(error => {
      console.error("Failed to clear html5QrcodeScanner. ", error);
    });
    html5QrcodeScanner = null;
  }
}

if (closeQrScannerBtn) {
  closeQrScannerBtn.addEventListener('click', closeQrScanner);
}

if (submitQrCodeBtn) {
  submitQrCodeBtn.addEventListener('click', async () => {
    const code = qrCodeInput.value.trim();
    const studentId = qrStudentIdInput.value.trim();
    
    if (!code || !studentId) {
      if (typeof showError === 'function') showError('กรุณากรอกรหัสนักเรียนและรหัสเช็คชื่อ');
      else alert('กรุณากรอกรหัสนักเรียนและรหัสเช็คชื่อ');
      return;
    }
    
    submitQrCodeBtn.disabled = true;
    try {
      const response = await fetch("/api/attendance/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, studentId })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.message || 'เช็คชื่อไม่สำเร็จ');
      }
      
      closeQrScanner();
      
      result.textContent = data.message;
      if (data.alreadyCheckedIn) {
        playSound('already');
        showFeedback('already');
      } else {
        playSound('success');
        showFeedback('success');
      }
      studentIdInput.value = '';
      
    } catch(err) {
      if (typeof showError === 'function') showError(err.message);
      else alert(err.message);
      playSound('error');
    } finally {
      submitQrCodeBtn.disabled = false;
    }
  });
}
