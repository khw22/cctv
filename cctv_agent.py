import sys
import os
import threading
sys.path.append(os.path.join(os.path.abspath(os.path.dirname(__file__)), 'edge-device'))

import cv2
import time
import requests
from datetime import datetime, timezone
from ultralytics import YOLO
from agent.client import EdgeClient
from agent.config import load

# 💡 수정 1: 통신 실패 시 터미널에 에러 메시지를 띄워 원인을 파악할 수 있도록 개선
def send_api_async(url: str, payload: dict):
    def _send():
        try:
            res = requests.post(url, json=payload, timeout=2.0)
            if res.status_code not in [200, 201]:
                print(f"[!] 서버 전송 실패: {res.status_code} - {res.text}")
        except Exception as e:
            pass # 아예 연결이 안 될 때는 영상 렉 방지를 위해 무시
    # 메인 영상 재생에 영향을 주지 않도록 별도의 쓰레드(일꾼) 생성
    threading.Thread(target=_send, daemon=True).start()

def run_video_pipeline(video_path: str, interval: float = 2.0):
    cfg = load()
    client = EdgeClient(cfg)
    
    SERVER_URL = "http://localhost:8000"
    DEVICE_ID = "local-ai-server"
    
    print("[*] 화재 감지 AI 모델(fire.pt)을 불러오는 중입니다...")
    model = YOLO('fire.pt') 
    
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"[!] '{video_path}' 동영상을 열 수 없습니다.")
        return

    fps = cap.get(cv2.CAP_PROP_FPS)
    delay = 1 / fps if fps > 0 else 0.033

    print(f"[*] 동영상({video_path}) 분석 시작 (종료: 영상 창 클릭 후 'q' 키)")

    frame_count = 0
    last_send_time = time.time()
    
    fire_origins = {} 

    while True:
        start_time = time.time()

        ret, frame = cap.read()
        if not ret:
            print("[*] 영상 재생이 끝났습니다. 처음부터 다시 반복합니다.")
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            fire_origins.clear() 
            continue
            
        frame_count += 1
        
        # 💡 수정 2: conf를 0.25로 살짝 올려서 빨간 자동차 등 오탐지 억제
        results = model.track(frame, persist=True, verbose=False, conf=0.25, imgsz=640)
        annotated_frame = results[0].plot() 
        cv2.imshow("Capstone Fire Detection", annotated_frame)
        
        current_time = time.time()
        if current_time - last_send_time >= interval:
            iso_timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

            # ---------------------------------------------------------
            # 1. 생존 신고 (Heartbeat)
            # ---------------------------------------------------------
            heartbeat_payload = {
                "timestamp": iso_timestamp,
                "status": "ok",
                "agent": {
                    "video_source": video_path,       
                    "processed_frames": frame_count,  
                    "cpu_percent": 15.0,              
                    "mem_percent": 30.0               
                },
                "camera": {
                    "connected": True,
                    "fps": 15.0
                },
                "inference": {
                    "model_version": "yolov8-fire-v2",
                    "avg_latency_ms": int((time.time() - start_time) * 1000)
                }
            }
            send_api_async(f"{SERVER_URL}/api/devices/{DEVICE_ID}/heartbeat", heartbeat_payload)

            # ---------------------------------------------------------
            # 2. 화재 감지 알람 (Event) - 추적 ID가 없어도 무조건 전송
            # ---------------------------------------------------------
            boxes = results[0].boxes
            # 💡 수정 3: boxes.id is not None 조건을 빼서 박스만 쳐지면 바로 서버로 넘김
            if len(boxes) > 0: 
                for i in range(len(boxes)):
                    box = boxes.xywh[i]
                    # 💡 ID가 안 잡혔다면 임시로 0번을 부여하여 오류 방지
                    track_id = int(boxes.id[i]) if boxes.id is not None else 0 
                    current_x, current_y = int(box[0]), int(box[1])
                    
                    width, height = int(box[2]), int(box[3])
                    fire_size = width * height
                    
                    if fire_size >= 10000:
                        severity_level = "critical"
                        size_text = f"대형 ({fire_size}px)"
                    elif fire_size >= 3000:
                        severity_level = "warning" 
                        size_text = f"중형 ({fire_size}px)"
                    else:
                        severity_level = "info"
                        size_text = f"소형 ({fire_size}px)"

                    if track_id not in fire_origins:
                        fire_origins[track_id] = (current_x, current_y)
                        print(f"[🚨] 화재 감지 ➡️ 대시보드 전송! (ID:{track_id}, X:{current_x}, Y:{current_y})")
                    
                    origin_x, origin_y = fire_origins[track_id]
                    
                    tracking_msg = f"[화염-{track_id}] 발화점(X:{origin_x}, Y:{origin_y}) ➡️ 현재(X:{current_x}, Y:{current_y}) | 크기: {size_text}"
                    
                    event_payload = {
                        "timestamp": iso_timestamp,
                        "event_type": "fire_detected",
                        "severity": severity_level, 
                        "message": tracking_msg
                    }
                    send_api_async(f"{SERVER_URL}/api/devices/{DEVICE_ID}/events", event_payload)
            else:
                fire_origins.clear()

            # ---------------------------------------------------------
            # 3. 사진(스냅샷) 전송 
            # ---------------------------------------------------------
            success, buffer = cv2.imencode(".jpg", annotated_frame)
            if success:
                frame_id = f"video_{frame_count:05d}"
                def _send_snap(buf, f_id):
                    try:
                        client.snapshot(buf, frame_id=f_id)
                    except Exception:
                        pass
                threading.Thread(target=_send_snap, args=(buffer.tobytes(), frame_id), daemon=True).start()
                    
            last_send_time = current_time

        process_time = time.time() - start_time
        if process_time < delay:
            time.sleep(delay - process_time)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    video_file = "fire1.mp4"
    run_video_pipeline(video_file, interval=2.0)