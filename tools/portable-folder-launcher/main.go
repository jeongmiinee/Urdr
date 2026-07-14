//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const appName = "World Archive"

var logger *log.Logger

func messageBox(title, text string, flags uintptr) {
	if runtime.GOOS != "windows" {
		fmt.Fprintln(os.Stderr, title+": "+text)
		return
	}
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(title)
	proc.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
}

func initLogger(root string) (*os.File, error) {
	path := filepath.Join(root, "launcher.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, err
	}
	logger = log.New(io.MultiWriter(f, os.Stderr), "", log.LstdFlags|log.Lmicroseconds)
	return f, nil
}

func existingFile(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

func findViaRegistry(exeName string) string {
	keys := []string{
		`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\` + exeName,
		`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\` + exeName,
		`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\` + exeName,
	}
	for _, key := range keys {
		out, err := exec.Command("reg.exe", "query", key, "/ve").CombinedOutput()
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if i := strings.Index(strings.ToUpper(line), "REG_SZ"); i >= 0 {
				candidate := strings.TrimSpace(line[i+len("REG_SZ"):])
				if existingFile(candidate) {
					return candidate
				}
			}
		}
	}
	return ""
}

func findBrowser() (string, string, error) {
	type browserCandidate struct {
		kind string
		exe  string
		rel  []string
	}
	candidates := []browserCandidate{
		{"edge", "msedge.exe", []string{"Microsoft", "Edge", "Application", "msedge.exe"}},
		{"chrome", "chrome.exe", []string{"Google", "Chrome", "Application", "chrome.exe"}},
	}
	roots := []string{
		os.Getenv("ProgramFiles(x86)"),
		os.Getenv("ProgramFiles"),
		os.Getenv("LocalAppData"),
	}
	for _, candidate := range candidates {
		if path, err := exec.LookPath(candidate.exe); err == nil && existingFile(path) {
			return candidate.kind, path, nil
		}
		if path := findViaRegistry(candidate.exe); path != "" {
			return candidate.kind, path, nil
		}
		for _, root := range roots {
			if root == "" {
				continue
			}
			path := filepath.Join(append([]string{root}, candidate.rel...)...)
			if existingFile(path) {
				return candidate.kind, path, nil
			}
		}
	}
	return "", "", errors.New("Microsoft Edge 또는 Google Chrome을 찾지 못했습니다")
}

func openDefaultBrowser(url string) error {
	cmd := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err == nil {
		return nil
	}
	cmd = exec.Command("cmd.exe", "/D", "/S", "/C", "start", "", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Start()
}

func launchAppBrowser(browserPath, url, profile string) (*exec.Cmd, error) {
	cmd := exec.Command(browserPath,
		"--app="+url,
		"--user-data-dir="+profile,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-sync",
		"--disable-background-mode",
		"--disable-features=msEdgeSidebarV2,msEdgeShoppingAssistant,ChromeWhatsNewUI",
		"--window-size=1440,960",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd, cmd.Start()
}

func runSelfTest(root string) error {
	required := []string{
		filepath.Join(root, "web", "index.html"),
		filepath.Join(root, "web", "mapgen4", "index.html"),
		filepath.Join(root, "web", "mapgen4", "build", "_bundle.js"),
		filepath.Join(root, "web", "mapgen4", "build", "_worker.js"),
		filepath.Join(root, "web", "mapgen4", "build", "points-5.5.data"),
	}
	for _, path := range required {
		st, err := os.Stat(path)
		if err != nil || st.IsDir() || st.Size() == 0 {
			return fmt.Errorf("필수 파일이 없거나 비어 있습니다: %s", path)
		}
	}
	return nil
}

type launcherState struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

func launcherStatePath() string {
	return filepath.Join(os.TempDir(), "world-archive-v099w-launcher.json")
}

func activateExistingLauncher() bool {
	path := launcherStatePath()
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var state launcherState
	if json.Unmarshal(data, &state) != nil || state.URL == "" || state.Token == "" {
		_ = os.Remove(path)
		return false
	}
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	response, err := client.Get(strings.TrimRight(state.URL, "/") + "/__activate?token=" + state.Token)
	if err == nil {
		_ = response.Body.Close()
		if response.StatusCode == http.StatusOK {
			return true
		}
	}
	_ = os.Remove(path)
	return false
}

func writeLauncherState(url, token string) error {
	data, err := json.Marshal(launcherState{URL: url, Token: token})
	if err != nil {
		return err
	}
	return os.WriteFile(launcherStatePath(), data, 0600)
}

func main() {
	exe, err := os.Executable()
	if err != nil {
		messageBox(appName, "실행 파일 경로를 확인할 수 없습니다.", 0x10)
		return
	}
	rootDir := filepath.Dir(exe)
	logFile, logErr := initLogger(rootDir)
	if logErr == nil {
		defer logFile.Close()
	}
	if logger == nil {
		logger = log.New(os.Stderr, "", log.LstdFlags)
	}
	logger.Printf("launcher start: exe=%s args=%q", exe, os.Args)

	if err := runSelfTest(rootDir); err != nil {
		logger.Printf("self-test failed: %v", err)
		messageBox(appName, err.Error()+"\n\nZIP 전체를 새 폴더에 다시 압축 해제하십시오.\n세부 내용은 launcher.log를 확인하십시오.", 0x10)
		return
	}
	logger.Printf("self-test passed")

	if len(os.Args) > 1 && os.Args[1] == "--self-test" {
		messageBox(appName, "필수 실행 파일과 지도 엔진 파일이 모두 정상입니다.", 0x40)
		return
	}

	if activateExistingLauncher() {
		logger.Printf("existing launcher activated")
		return
	}

	appRoot := filepath.Join(rootDir, "web")
	_ = mime.AddExtensionType(".wasm", "application/wasm")
	_ = mime.AddExtensionType(".swf", "application/x-shockwave-flash")
	_ = mime.AddExtensionType(".data", "application/octet-stream")

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		logger.Printf("listen failed: %v", err)
		messageBox(appName, "로컬 앱 서버를 시작할 수 없습니다.\n"+err.Error()+"\n\nlauncher.log를 확인하십시오.", 0x10)
		return
	}
	logger.Printf("server listen: %s", listener.Addr())

	profile, err := os.MkdirTemp("", "world-archive-v099w-")
	if err != nil {
		logger.Printf("profile create failed: %v", err)
		_ = listener.Close()
		messageBox(appName, "임시 실행 프로필을 만들 수 없습니다.\n"+err.Error(), 0x10)
		return
	}
	defer os.RemoveAll(profile)

	forceDefault := false
	for _, arg := range os.Args[1:] {
		if arg == "--browser" || arg == "--safe-mode" {
			forceDefault = true
		}
	}
	browserKind, browserPath, browserFindErr := "", "", error(nil)
	if !forceDefault {
		browserKind, browserPath, browserFindErr = findBrowser()
	}
	var launchMu sync.Mutex
	var activeStreams atomic.Int32
	var everConnected atomic.Bool
	var zeroSince atomic.Int64

	mux := http.NewServeMux()
	activationToken := fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())
	baseURL := "http://" + listener.Addr().String()
	mux.HandleFunc("/__status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		_, _ = fmt.Fprint(w, "ok")
	})
	mux.HandleFunc("/__activate", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != activationToken {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		_, _ = fmt.Fprint(w, "activated")
		go func() {
			launchMu.Lock()
			defer launchMu.Unlock()
			url := baseURL + "/?portable=1&activate=" + fmt.Sprint(time.Now().UnixNano())
			if browserPath != "" {
				cmd, launchErr := launchAppBrowser(browserPath, url, profile)
				if launchErr == nil && cmd != nil {
					logger.Printf("existing instance window restored: pid=%d", cmd.Process.Pid)
					go func() { _ = cmd.Wait() }()
					return
				}
				logger.Printf("restore app window failed: %v", launchErr)
			}
			if err := openDefaultBrowser(url); err != nil {
				logger.Printf("restore default browser failed: %v", err)
			}
		}()
	})
	mux.HandleFunc("/__keepalive", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Connection", "keep-alive")
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unavailable", http.StatusInternalServerError)
			return
		}
		count := activeStreams.Add(1)
		everConnected.Store(true)
		logger.Printf("keepalive connected: active=%d path=%s", count, r.Referer())
		defer func() {
			remaining := activeStreams.Add(-1)
			if remaining == 0 {
				zeroSince.Store(time.Now().UnixNano())
			}
			logger.Printf("keepalive disconnected: active=%d", remaining)
		}()
		_, _ = fmt.Fprint(w, ": connected\n\n")
		flusher.Flush()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	})

	fileServer := http.FileServer(http.Dir(appRoot))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		fileServer.ServeHTTP(w, r)
	})

	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	serveDone := make(chan struct{})
	go func() {
		err := server.Serve(listener)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Printf("server error: %v", err)
		}
		close(serveDone)
	}()

	url := baseURL + "/?portable=1"
	if err := writeLauncherState(baseURL, activationToken); err != nil {
		logger.Printf("state write failed: %v", err)
	}
	defer func() {
		_ = os.Remove(launcherStatePath())
	}()

	var browserCmd *exec.Cmd
	if !forceDefault {
		if browserFindErr == nil {
			logger.Printf("browser found: kind=%s path=%s", browserKind, browserPath)
			browserCmd, err = launchAppBrowser(browserPath, url, profile)
			if err != nil {
				logger.Printf("app mode launch failed: %v", err)
			} else {
				logger.Printf("app mode launched: pid=%d", browserCmd.Process.Pid)
				go func() {
					waitErr := browserCmd.Wait()
					logger.Printf("browser process ended: %v", waitErr)
				}()
			}
		} else {
			logger.Printf("browser discovery failed: %v", browserFindErr)
		}
	}

	if browserCmd == nil {
		logger.Printf("using default browser fallback")
		if err := openDefaultBrowser(url); err != nil {
			logger.Printf("default browser launch failed: %v", err)
			_ = server.Shutdown(context.Background())
			messageBox(appName, "프로그램 창을 열 수 없습니다.\n"+err.Error()+"\n\nlauncher.log를 확인하십시오.", 0x10)
			return
		}
	}

	connectDeadline := time.Now().Add(75 * time.Second)
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if everConnected.Load() {
			break
		}
		if time.Now().After(connectDeadline) {
			logger.Printf("no keepalive connection within startup deadline")
			_ = server.Shutdown(context.Background())
			messageBox(appName, "World Archive 화면과 연결하지 못했습니다.\n\nWindows 보안 차단을 해제하거나 '안전 모드로 실행.cmd'를 사용하십시오.\n세부 내용은 launcher.log를 확인하십시오.", 0x10)
			return
		}
	}

	logger.Printf("application connected")
	for range ticker.C {
		if activeStreams.Load() > 0 {
			continue
		}
		z := zeroSince.Load()
		if z != 0 && time.Since(time.Unix(0, z)) >= 5*time.Second {
			logger.Printf("all application windows closed")
			break
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	<-serveDone
	logger.Printf("launcher exit")
}
