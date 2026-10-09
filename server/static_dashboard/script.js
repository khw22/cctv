// 중앙 서버 대시보드 - 라이브 백엔드 연동

const API_BASE = (window.API_BASE || "http://localhost:8000").replace(/\/+$/, "");

let clearTimestamp = 0; 
let allFetchedEvents = []; 

async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`, {
        headers: { "Accept": "application/json" },
    });
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (!res.ok || (body && body.ok === false)) {
        const code = body && body.error ? body.error.code : `http_${res.status}`;
        const msg = body && body.error ? body.error.message : res.statusText;
        throw new Error(`[${code}] ${msg}`);
    }
    return body;
}

function setBody(tableId, html) {
    const tbody = document.querySelector(`#${tableId} tbody`);
    if (tbody) tbody.innerHTML = html;
}

function colCount(tableId) {
    return document.querySelectorAll(`#${tableId} thead th`).length || 1;
}

function fullWidthRow(tableId, text, cls) {
    return `<tr><td class="${cls}" colspan="${colCount(tableId)}">${text}</td></tr>`;
}

function show(v) { return (v === null || v === undefined || v === "") ? "—" : v; }

function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
           `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusBadge(status) {
    if (status === "ok") return `<span class="badge ok">정상</span>`;
    if (!status) return `<span class="badge warn">대기</span>`;
    return `<span class="badge bad">${status}</span>`;
}

function setApiStatus(state, text) {
    const wrap = document.getElementById("api-status");
    const label = document.getElementById("api-status-text");
    if (wrap) wrap.className = `api-status ${state}`;
    if (label) label.textContent = text;
}

function isOnline(dev) { return dev.status === "ok"; }

function renderCctvTable(devices) {
    if (!devices.length) {
        setBody("cctv-table", fullWidthRow("cctv-table", "등록된 장치가 없습니다.", "muted"));
        return;
    }
    setBody("cctv-table", devices.map((d) => `
        <tr>
            <td>${show(d.device_id)}</td>
            <td>${show(d.location)}</td>
            <td>${statusBadge(d.status)}</td>
            <td>${show(d.fps)}</td>
            <td>${show(d.model_version)}</td>
            <td>${fmtTime(d.last_seen)}</td>
        </tr>
    `).join(""));
}

function renderStatCards(devices) {
    const total = devices.length;
    const online = devices.filter(isOnline).length;
    const offline = total - online;

    const set = (id, value, cls) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = value;
        if (cls) el.className = `value ${cls}`;
    };
    set("stat-online", `${online} / ${total}`);
    set("stat-streaming", online, "ok");
    set("stat-offline", offline, offline ? "warn" : "ok");
    set("stat-server", "정상", "ok");

    const versions = devices.map((d) => d.model_version).filter(Boolean);
    const mv = document.getElementById("setting-model-version");
    if (mv) mv.textContent = versions.length ? versions[versions.length - 1] : "미보고";
}

function renderRealtimeUnavailable(message) {
    setBody("cctv-table", fullWidthRow("cctv-table", message, "error"));
    ["stat-online", "stat-streaming", "stat-offline"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) { el.textContent = "—"; el.className = "value"; }
    });
    const sv = document.getElementById("stat-server");
    if (sv) { sv.textContent = "오프라인"; sv.className = "value bad"; }
}

async function loadRealtime() {
    const data = await apiGet("/api/devices");
    const devices = (data && data.devices) || [];
    renderCctvTable(devices);
    renderStatCards(devices);
    return devices;
}

const SEVERITY_LABEL = { info: "정보", warning: "주의", critical: "위험" };

async function loadEvents(devices) {
    if (!devices.length) {
        setBody("events-table", fullWidthRow("events-table", "이벤트가 없습니다.", "muted"));
        setBody("fire-origin-table", fullWidthRow("fire-origin-table", "장치가 없습니다.", "muted"));
        return;
    }
    
    const results = await Promise.allSettled(
        devices.map((d) =>
            apiGet(`/api/devices/${encodeURIComponent(d.device_id)}/events?limit=100`)
                .then((r) => ((r && r.events) || []).map((e) => ({ ...e, device_id: d.device_id })))
        )
    );

    const events = [];
    let anyFailed = false;
    for (const r of results) {
        if (r.status === "fulfilled") events.push(...r.value);
        else anyFailed = true;
    }
    events.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

    allFetchedEvents = events;

    const displayEvents = events.filter(e => new Date(e.timestamp).getTime() >= clearTimestamp);

    if (!displayEvents.length) {
        const msg = anyFailed ? "일부 장치의 이벤트를 불러오지 못했습니다." : "현재 표시할 이벤트가 없습니다.";
        setBody("events-table", fullWidthRow("events-table", msg, anyFailed ? "error" : "muted"));
        setBody("fire-origin-table", fullWidthRow("fire-origin-table", "현재 감지된 화재가 없습니다 (안전 상태).", "ok"));
        return;
    }

    setBody("events-table", displayEvents.map((e) => {
        const sev = SEVERITY_LABEL[e.severity] || e.severity || "";
        const type = e.event_type ? `${e.event_type}${sev ? ` (${sev})` : ""}` : show(sev);
        return `
        <tr>
            <td>${fmtTime(e.timestamp)}</td>
            <td>${show(e.device_id)}</td>
            <td>${type}</td>
            <td>${show(e.message)}</td>
        </tr>`;
    }).join(""));

    const fireEvents = displayEvents.filter(e => e.message && e.message.includes("X:"));
    
    if (fireEvents.length > 0) {
        setBody("fire-origin-table", fireEvents.map((e) => {
            const sev = SEVERITY_LABEL[e.severity] || e.severity || "";
            return `
            <tr>
                <td>${show(e.device_id)}</td>
                <td>${fmtTime(e.timestamp)}</td>
                <td style="font-weight: bold; color: #ff6b6b;">${show(e.message)}</td>
                <td><span class="badge bad">${sev}</span></td>
            </tr>`;
        }).join(""));
    } else {
        setBody("fire-origin-table", fullWidthRow("fire-origin-table", "현재 감지된 화재가 없습니다 (안전 상태).", "ok"));
    }
}

function renderUnbackedSections() {
    setBody("pollution-table", fullWidthRow("pollution-table", "AI 오염도(쓰레기/꽁초) 탐지 모델 적용 대기 중입니다.", "muted"));
    setBody("fire-origin-table", fullWidthRow("fire-origin-table", "현재 감지된 화재가 없습니다 (안전 상태).", "ok")); 
}

document.addEventListener("DOMContentLoaded", async () => {
    const apiBaseEl = document.getElementById("setting-api-base");
    if (apiBaseEl) apiBaseEl.textContent = API_BASE;

    renderUnbackedSections();

    // 💡 1. 화면 지우기 -> 영구 삭제(DELETE API 호출)로 완벽 교체
    const btnClear = document.getElementById("btn-clear");
    if (btnClear) {
        btnClear.addEventListener("click", async () => {
            if (!confirm("모든 이벤트 기록을 영구적으로 삭제하시겠습니까?\n데이터베이스에서 완전히 지워지며 되돌릴 수 없습니다.")) {
                return;
            }

            try {
                // 등록된 장치(rpi-001 등)의 이벤트를 서버 DB에서 완전히 날려버림
                const data = await loadRealtime();
                for (const d of data) {
                    await fetch(`${API_BASE}/api/devices/${encodeURIComponent(d.device_id)}/events`, {
                        method: "DELETE"
                    });
                }
                
                alert("영구 삭제 완료!");
                allFetchedEvents = []; // 다운로드용 메모리도 비우기
                
                // 표 비우기
                setBody("events-table", fullWidthRow("events-table", "이벤트가 없습니다.", "muted"));
                setBody("fire-origin-table", fullWidthRow("fire-origin-table", "현재 감지된 화재가 없습니다 (안전 상태).", "ok"));
                
            } catch (err) {
                alert("삭제 중 서버 연결 오류: " + err.message);
            }
        });
    }

    const btnExport = document.getElementById("btn-export");
    if (btnExport) {
        btnExport.addEventListener("click", () => {
            if (!allFetchedEvents.length) return alert("저장할 데이터가 없습니다.");
            
            let csv = "발생일시,장치ID,이벤트유형,위험도,상세내용\n";
            allFetchedEvents.forEach(e => {
                const time = fmtTime(e.timestamp);
                const dev = e.device_id || "";
                const type = e.event_type || "";
                const sev = SEVERITY_LABEL[e.severity] || e.severity || "";
                const msg = (e.message || "").replace(/,/g, " ");
                csv += `${time},${dev},${type},${sev},${msg}\n`;
            });

            const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `관제기록_${new Date().getTime()}.csv`;
            a.click();
        });
    }

    const refreshData = async () => {
        try {
            const devices = await loadRealtime();
            setApiStatus("online", `API 연결됨 · 장치 ${devices.length}대`);
            await loadEvents(devices);
        } catch (err) {
            setApiStatus("offline", "API 서버에 연결할 수 없습니다");
            renderRealtimeUnavailable(`서버에 연결할 수 없습니다: ${err.message}`);
        }
    };

    // 💡 2. 최초 1회만 데이터를 불러오고 끝냅니다. 
    await refreshData();
    
    // ❌ 5초 자동 새로고침(setInterval) 기능을 완전히 삭제했습니다.
    // 이제 터미널에 불필요한 로그가 계속 찍히지 않습니다.
    // (대신 새로운 화재 데이터를 확인하려면 브라우저 새로고침[F5]을 직접 눌러야 합니다!)
});

// --- 날씨 및 날짜 위젯 연동 기능 (위치 추적, 한글 지역명, 검색 완벽 지원) ---
document.addEventListener("DOMContentLoaded", () => {
    
    // 아까 발급받으신 OpenWeatherMap API 키 적용 완료
    const apiKey = 'b951e5f62b5c54c38f7ea89a8675ff20'; 

    // 1. 날짜 업데이트
    function updateDate() {
        const dateElement = document.getElementById('current-date');
        if(!dateElement) return;
        const today = new Date();
        const year = today.getFullYear();
        const month = today.getMonth() + 1;
        const date = today.getDate();
        const days = ['일', '월', '화', '수', '목', '금', '토'];
        dateElement.textContent = `${year}년 ${month}월 ${date}일 ${days[today.getDay()]}요일`;
    }

    // 2. 받아온 날씨 데이터를 화면에 예쁘게 그려주는 함수
    function renderWeather(data) {
        const temp = Math.round(data.main.temp); 
        const humidity = data.main.humidity;     
        const weatherCondition = data.weather[0].main;

        // OpenWeatherMap의 영문 도시명을 한글로 매핑 (주요 도시)
        const cityMap = {
            "Seoul": "서울", "Incheon": "인천", "Busan": "부산", "Daegu": "대구",
            "Daejeon": "대전", "Gwangju": "광주", "Ulsan": "울산", "Jeju City": "제주", "Jeju": "제주",
            "Suwon": "수원", "Goyang": "고양", "Yongin": "용인", "Seongnam": "성남",
            "Cheongju": "청주", "Jeonju": "전주", "Cheonan": "천안", "Changwon": "창원"
        };
        // 매핑된 한글 이름이 있으면 쓰고, 없으면 받아온 원본 이름 사용
        const cityName = cityMap[data.name] || data.name; 

        let weatherEmoji = '🌤️'; 
        if (weatherCondition === 'Clear') weatherEmoji = '☀️';
        else if (weatherCondition === 'Clouds') weatherEmoji = '☁️';
        else if (weatherCondition === 'Rain' || weatherCondition === 'Drizzle') weatherEmoji = '🌧️';
        else if (weatherCondition === 'Thunderstorm') weatherEmoji = '⛈️';
        else if (weatherCondition === 'Snow') weatherEmoji = '❄️';
        else if (['Mist', 'Smoke', 'Haze', 'Dust', 'Fog', 'Sand', 'Ash', 'Squall', 'Tornado'].includes(weatherCondition)) weatherEmoji = '🌫️';

        // 💡 기존 HTML 구조 안에 '📍 한글 지역명'을 파란색으로 예쁘게 추가하여 렌더링
        const weatherInfo = document.querySelector('.weather-info');
        if (weatherInfo) {
            weatherInfo.innerHTML = `
                <span style="color: #38bdf8; font-weight: bold; margin-right: 8px;">📍 ${cityName}</span>
                <span id="temperature">${weatherEmoji} ${temp}°C</span> 
                <span id="humidity" style="margin-left: 8px;">💧 ${humidity}%</span>
            `;
        }
    }

    // 3. 지역 이름(한글/영문 모두 가능)으로 날씨 검색
    async function fetchWeatherByCity(city) {
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric&lang=kr`;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error("API 연결 실패");
            const data = await response.json();
            renderWeather(data);
        } catch (error) {
            alert(`"${city}"의 날씨를 찾을 수 없습니다. (예: 서울, 부산, 인천)`);
        }
    }

    // 4. GPS를 이용해 사용자가 접속한 현재 위치의 날씨 연동
    function fetchWeatherByLocation() {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                async (position) => {
                    const lat = position.coords.latitude;
                    const lon = position.coords.longitude;
                    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=kr`;
                    try {
                        const response = await fetch(url);
                        if (!response.ok) throw new Error("API 연결 실패");
                        const data = await response.json();
                        renderWeather(data);
                    } catch (error) {
                        fetchWeatherByCity('Incheon'); // 에러 시 인천을 띄움
                    }
                },
                (error) => {
                    // 위치 권한 거부 시 기본값 인천
                    fetchWeatherByCity('Incheon');
                }
            );
        } else {
            fetchWeatherByCity('Incheon');
        }
    }

    // 5. 날씨 위젯 클릭 시 검색창 띄우기
    const weatherWidget = document.getElementById('weather-widget');
    if (weatherWidget) {
        weatherWidget.style.cursor = 'pointer';
        weatherWidget.style.transition = 'background-color 0.2s';
        
        // 마우스 호버 효과
        weatherWidget.addEventListener('mouseenter', () => weatherWidget.style.backgroundColor = 'rgba(255, 255, 255, 0.15)');
        weatherWidget.addEventListener('mouseleave', () => weatherWidget.style.backgroundColor = 'rgba(255, 255, 255, 0.06)');

        weatherWidget.addEventListener('click', () => {
            // 이번엔 한글로 검색해도 알아듣도록 처리했습니다!
            const userCity = prompt("날씨를 확인할 지역을 검색하세요 (예: 서울, 부산, 인천, 제주):", "서울");
            if (userCity) {
                fetchWeatherByCity(userCity.trim());
            }
        });
    }

    // 초기 실행 (대시보드를 켜면 가장 먼저 현재 GPS 위치 날씨를 불러옴)
    updateDate();
    fetchWeatherByLocation(); 
});

// --- 비디오 업로드 및 화면 재생(미리보기) 기능 ---
document.addEventListener("DOMContentLoaded", () => {
    const videoUpload = document.getElementById("video-upload");
    const uploadStatus = document.getElementById("upload-status");
    const analysisTableBody = document.querySelector("#analysis-table tbody");
    
    // 비디오 플레이어 관련 요소
    const previewContainer = document.getElementById("video-preview-container");
    const videoPlayer = document.getElementById("video-player");
    const videoFilename = document.getElementById("video-filename");

    let uploadedFiles = []; // 업로드된 파일들을 저장할 배열

    if (videoUpload) {
        videoUpload.addEventListener("change", (event) => {
            const files = event.target.files;
            if (files.length === 0) return;

            uploadedFiles = Array.from(files); // 파일 목록 갱신
            uploadStatus.textContent = `총 ${uploadedFiles.length}개의 영상이 선택되었습니다.`;
            analysisTableBody.innerHTML = ""; // 표 초기화

            uploadedFiles.forEach((file, index) => {
                const row = document.createElement("tr");
                row.innerHTML = `
                    <td style="font-weight: bold;">${file.name}</td>
                    <td><span class="badge warn">대기 중</span></td>
                    <td>0%</td>
                    <td>-</td>
                    <td style="display: flex; gap: 6px;">
                        <!-- 💡 미리보기 버튼 -->
                        <button class="preview-btn" data-index="${index}" style="padding: 4px 8px; background: #6b7a90; color: white; border: none; border-radius: 4px; cursor: pointer;">
                            👁️ 미리보기
                        </button>
                        <!-- 분석 시작 버튼 -->
                        <button class="start-analysis-btn" data-index="${index}" style="padding: 4px 8px; background: #1f8a4c; color: white; border: none; border-radius: 4px; cursor: pointer;">
                            ▶ 분석 시작
                        </button>
                    </td>
                `;
                analysisTableBody.appendChild(row);
            });
        });

        // 표 안의 버튼 클릭 이벤트 (이벤트 위임 방식)
        analysisTableBody.addEventListener("click", (e) => {
            // 1. '미리보기' 버튼을 눌렀을 때
            if (e.target.classList.contains("preview-btn")) {
                const index = e.target.getAttribute("data-index");
                const file = uploadedFiles[index];
                
                // 브라우저 내부에서만 임시로 쓸 수 있는 영상 주소 생성
                const fileURL = URL.createObjectURL(file);
                
                // 비디오 플레이어에 주소 연결 및 재생
                videoPlayer.src = fileURL;
                videoFilename.textContent = `▶ 현재 재생 중: ${file.name}`;
                previewContainer.style.display = "block"; // 숨겨진 플레이어 표시
                videoPlayer.play(); // 자동 재생
            }

            // 2. '분석 시작' 버튼을 눌렀을 때 (실제 백엔드 API 연동)
            if (e.target.classList.contains("start-analysis-btn")) {
                const index = e.target.getAttribute("data-index");
                const file = uploadedFiles[index];
                const btn = e.target;
                
                btn.textContent = "⏳ 업로드 중...";
                btn.style.background = "#c87a00";
                
                // 1) 비디오 파일 백엔드로 전송
                const formData = new FormData();
                formData.append("file", file);
                
                fetch(`${API_BASE}/api/upload`, {
                    method: "POST",
                    body: formData
                })
                .then(res => res.json())
                .then(data => {
                    btn.textContent = "🔥 실시간 분석 중";
                    btn.style.background = "#c0392b";
                    
                    // 2) 원본 플레이어 숨기고 AI 스트리밍 이미지(img) 표시
                    document.getElementById("video-player").style.display = "none";
                    document.getElementById("video-player").pause();
                    
                    const aiPlayer = document.getElementById("ai-stream-player");
                    aiPlayer.style.display = "block";
                    videoFilename.textContent = `🔥 실시간 AI 분석 중: ${file.name}`;
                    previewContainer.style.display = "block";
                    
                    // 3) 백엔드 스트리밍 주소 연결
                    aiPlayer.src = `${API_BASE}/api/stream/${data.filename}`;
                    
                    // 4) 1초마다 이벤트 기록(화재 로그) 자동 새로고침
                    setInterval(async () => {
                        const devices = await loadRealtime();
                        await loadEvents(devices);
                    }, 1000);
                })
                .catch(err => {
                    alert("서버 전송 실패! 파이썬 백엔드가 켜져 있는지 확인하세요.");
                    btn.textContent = "▶ 분석 시작";
                    btn.style.background = "#1f8a4c";
                });
            }
        });
    }
});