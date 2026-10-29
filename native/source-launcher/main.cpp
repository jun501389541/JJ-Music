#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winsafer.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <filesystem>
#include <map>
#include <string>
#include <vector>
#include <stdexcept>
#ifdef JJ_LAUNCHER_TEST_BARRIER
#include <fstream>
#endif
#include "argv.h"

namespace fs = std::filesystem;
struct Handle {
    HANDLE value = nullptr;
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle() = default;
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
struct Failure { const char* stage; DWORD code; };
struct Attributes {
    std::vector<BYTE> storage;
    LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
    ~Attributes() { if (value) DeleteProcThreadAttributeList(value); }
};
void Require(BOOL ok, const char* stage) { if (!ok) throw Failure{stage, GetLastError()}; }
std::string launchId;
bool Status(const std::string& body) {
    const std::string line = "{\"schema\":1,\"launchId\":\"" + launchId + "\"," + body + "}\n";
    DWORD written = 0;
    return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), line.data(), static_cast<DWORD>(line.size()), &written, nullptr)
        && written == line.size();
}
DWORD Number(const std::wstring& value, DWORD minimum, DWORD maximum) {
    if (value.empty() || value.size() > 10) throw Failure{"arguments", ERROR_INVALID_PARAMETER};
    unsigned long long result = 0;
    for (wchar_t ch : value) {
        if (ch < L'0' || ch > L'9') throw Failure{"arguments", ERROR_INVALID_PARAMETER};
        result = result * 10 + ch - L'0';
    }
    if (result < minimum || result > maximum) throw Failure{"arguments", ERROR_INVALID_PARAMETER};
    return static_cast<DWORD>(result);
}
bool HasShutdown(HANDLE token) {
    DWORD size = 0;
    GetTokenInformation(token, TokenPrivileges, nullptr, 0, &size);
    if (!size) throw Failure{"tokenQuery", GetLastError()};
    std::vector<BYTE> data(size);
    Require(GetTokenInformation(token, TokenPrivileges, data.data(), size, &size), "tokenQuery");
    LUID luid;
    Require(LookupPrivilegeValueW(nullptr, SE_SHUTDOWN_NAME, &luid), "tokenQuery");
    auto privileges = reinterpret_cast<TOKEN_PRIVILEGES*>(data.data());
    for (DWORD i = 0; i < privileges->PrivilegeCount; ++i) {
        const LUID actual = privileges->Privileges[i].Luid;
        if (actual.LowPart == luid.LowPart && actual.HighPart == luid.HighPart) return true;
    }
    return false;
}
DWORD ParentPid() {
    Handle snapshot;
    snapshot.value = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    Require(snapshot.value != INVALID_HANDLE_VALUE, "owner");
    PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot.value, &entry)) do {
        if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID;
    } while (Process32NextW(snapshot.value, &entry));
    throw Failure{"owner", ERROR_NOT_FOUND};
}

int Run() {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) throw Failure{"arguments", GetLastError()};
    std::map<std::wstring, std::wstring> options;
    const std::vector<std::wstring> keys = {L"--node", L"--host", L"--script", L"--init", L"--scratch", L"--memory-mb", L"--owner-pid", L"--launch-id"};
    bool valid = argc == 17;
    for (int i = 1; i + 1 < argc; i += 2) {
        const std::wstring key = argv[i];
        bool known = false;
        for (const auto& expected : keys) if (key == expected) known = true;
        if (!known || !options.emplace(key, argv[i+1]).second) valid = false;
    }
    LocalFree(argv);
    const auto id = options[L"--launch-id"];
    bool idValid = !id.empty() && id.size() <= 64;
    for (auto c : id) if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'-')) idValid = false;
    if (idValid) for (auto c : id) launchId.push_back(static_cast<char>(c));
    if (!valid || !idValid) throw Failure{"arguments", ERROR_INVALID_PARAMETER};
    const DWORD memory = Number(options[L"--memory-mb"], 16, 4096);
    const DWORD ownerPid = Number(options[L"--owner-pid"], 1, MAXDWORD);
    std::map<std::wstring, fs::path> paths;
    for (auto key : {L"--node", L"--host", L"--script", L"--init", L"--scratch"}) {
        fs::path path(options[key]);
        if (!path.is_absolute()) throw Failure{"arguments", ERROR_INVALID_PARAMETER};
        paths[key] = fs::canonical(path);
        const bool directory = std::wstring(key) == L"--scratch";
        if (directory ? !fs::is_directory(paths[key]) : !fs::is_regular_file(paths[key])) throw Failure{"arguments", ERROR_INVALID_PARAMETER};
    }
    for (auto key : {L"--script", L"--init"})
        if (paths[key].parent_path() != paths[L"--scratch"]) throw Failure{"arguments", ERROR_INVALID_PARAMETER};

    if (ParentPid() != ownerPid) throw Failure{"owner", ERROR_INVALID_PARAMETER};
    Handle owner;
    owner.value = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, ownerPid);
    Require(owner.value != nullptr, "owner");
    FILETIME ownerTime{}, selfTime{}, exitTime{}, kernel{}, user{};
    Require(GetProcessTimes(owner.value, &ownerTime, &exitTime, &kernel, &user), "owner");
    Require(GetProcessTimes(GetCurrentProcess(), &selfTime, &exitTime, &kernel, &user), "owner");
    if (CompareFileTime(&ownerTime, &selfTime) > 0 || WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT)
        throw Failure{"owner", ERROR_INVALID_PARAMETER};

    Handle original, safer, restricted;
    Require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY, &original.value), "token");
    SAFER_LEVEL_HANDLE level = nullptr;
    Require(SaferCreateLevel(SAFER_SCOPEID_USER, SAFER_LEVELID_NORMALUSER, SAFER_LEVEL_OPEN, &level, nullptr), "safer");
    BOOL computed = SaferComputeTokenFromLevel(level, original.value, &safer.value, 0, nullptr);
    DWORD saferError = GetLastError();
    SaferCloseLevel(level);
    if (!computed || !safer.value) throw Failure{"safer", saferError};
    HANDLE token = safer.value;
    if (HasShutdown(token)) {
        LUID_AND_ATTRIBUTES remove{};
        Require(LookupPrivilegeValueW(nullptr, SE_SHUTDOWN_NAME, &remove.Luid), "token");
        Require(CreateRestrictedToken(token, 0, 0, nullptr, 1, &remove, 0, nullptr, &restricted.value), "token");
        token = restricted.value;
    }
    if (HasShutdown(token)) throw Failure{"tokenCheck", ERROR_ACCESS_DENIED};

    Handle job;
    job.value = CreateJobObjectW(nullptr, nullptr);
    Require(job.value != nullptr, "job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "job");
    Require(SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", L"1"), "environment");
    std::wstring command = QuoteArgument(paths[L"--node"].wstring()) + L" --max-old-space-size=" + std::to_wstring(memory);
    for (auto key : {L"--host", L"--script", L"--init", L"--scratch"}) command += L" " + QuoteArgument(options[key]);
    if (command.size() >= 32767) throw Failure{"arguments", ERROR_FILENAME_EXCED_RANGE};
    // Atomically put even the suspended child in the Job. A separate Assign
    // after CreateProcess leaves an orphan window if this helper is killed.
    Attributes attributes;
    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
    if (!attributeBytes) throw Failure{"jobAttributes", GetLastError()};
    attributes.storage.resize(attributeBytes);
    auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.storage.data());
    Require(InitializeProcThreadAttributeList(list, 1, 0, &attributeBytes), "jobAttributes");
    attributes.value = list;
    Require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        &job.value, sizeof(job.value), nullptr, nullptr), "jobAttributes");
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = list;
    PROCESS_INFORMATION child{};
    const auto cwd = paths[L"--host"].parent_path().wstring();
    Require(CreateProcessAsUserW(token, paths[L"--node"].c_str(), command.data(), nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        nullptr, cwd.c_str(), &startup.StartupInfo, &child), "createProcess");
    Handle process, thread;
    process.value = child.hProcess; thread.value = child.hThread;
    try {
#ifdef JJ_LAUNCHER_TEST_BARRIER
        // Dedicated test build only: deterministically kill the helper between
        // successful creation and ResumeThread. No hooks in shipping builds.
        wchar_t marker[32768];
        DWORD length = GetEnvironmentVariableW(L"JJ_LAUNCHER_TEST_BARRIER", marker, 32768);
        if (length > 0 && length < 32768) {
            { std::ofstream file{fs::path(marker)}; file << child.dwProcessId; }
            Sleep(15000);
        }
#endif
        BOOL inJob = FALSE;
        Require(IsProcessInJob(process.value, job.value, &inJob), "verifyJob");
        if (!inJob) throw Failure{"verifyJob", ERROR_ACCESS_DENIED};
        Handle childToken;
        Require(OpenProcessToken(process.value, TOKEN_QUERY, &childToken.value), "childToken");
        if (HasShutdown(childToken.value)) throw Failure{"childToken", ERROR_ACCESS_DENIED};
        if (WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT) throw Failure{"owner", ERROR_PROCESS_ABORTED};
        Require(ResumeThread(thread.value) != static_cast<DWORD>(-1), "resume");
        if (!Status("\"type\":\"spawned\",\"pid\":" + std::to_string(child.dwProcessId)))
            throw Failure{"status", ERROR_BROKEN_PIPE};
        HANDLE waits[] = {owner.value, process.value};
        DWORD waited;
        const HANDLE control = GetStdHandle(STD_INPUT_HANDLE);
        const bool controlPipe = control && GetFileType(control) == FILE_TYPE_PIPE;
        for (;;) {
            waited = WaitForMultipleObjects(2, waits, FALSE, 100);
            if (waited != WAIT_TIMEOUT) break;
            // Parent writes a single stop byte. No blocking reader/thread and
            // no source IPC on this pipe; EOF alone is not a launch failure.
            DWORD available = 0;
            if (controlPipe && PeekNamedPipe(control, nullptr, 0, nullptr, &available, nullptr) && available) {
                char commandByte = 0; DWORD read = 0;
                if (ReadFile(control, &commandByte, 1, &read, nullptr) && read && commandByte == 'S') {
                    waited = WAIT_OBJECT_0;
                    break;
                }
            }
        }
        if (waited != WAIT_OBJECT_0 && waited != WAIT_OBJECT_0 + 1) throw Failure{"wait", GetLastError()};
        DWORD exitCode = 0;
        if (waited == WAIT_OBJECT_0 + 1) Require(GetExitCodeProcess(process.value, &exitCode), "childExit");
        Require(TerminateJobObject(job.value, ERROR_PROCESS_ABORTED), "terminateJob");
        if (WaitForSingleObject(process.value, 5000) != WAIT_OBJECT_0) throw Failure{"reap", ERROR_TIMEOUT};
        const ULONGLONG deadline = GetTickCount64() + 5000;
        for (;;) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
            Require(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation,
                &accounting, sizeof(accounting), nullptr), "reapJob");
            if (!accounting.ActiveProcesses) break;
            if (GetTickCount64() >= deadline) throw Failure{"reapJob", ERROR_TIMEOUT};
            Sleep(10);
        }
        if (waited == WAIT_OBJECT_0 + 1)
            Status("\"type\":\"childExit\",\"pid\":" + std::to_string(child.dwProcessId) + ",\"exitCode\":" + std::to_string(exitCode));
        return 0;
    } catch (...) {
        TerminateProcess(process.value, ERROR_PROCESS_ABORTED);
        TerminateJobObject(job.value, ERROR_PROCESS_ABORTED);
        WaitForSingleObject(process.value, 5000);
        throw;
    }
}
int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    // No dialogs on runtime failures and no console allocation at any stage.
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    try { return Run(); }
    catch (const Failure& failure) {
        Status(std::string("\"type\":\"launchError\",\"stage\":\"") + failure.stage + "\",\"win32Code\":" + std::to_string(failure.code) + ",\"message\":\"Restricted source launch failed\"");
    } catch (const fs::filesystem_error& error) {
        Status("\"type\":\"launchError\",\"stage\":\"arguments\",\"win32Code\":" + std::to_string(error.code().value()) + ",\"message\":\"Invalid launch path\"");
    } catch (...) {
        Status("\"type\":\"launchError\",\"stage\":\"internal\",\"win32Code\":1,\"message\":\"Restricted source launch failed\"");
    }
    return 1;
}
