"""Owner-only local runner profile registry; probes are explicit and non-inference."""
from __future__ import annotations
import argparse, base64, fcntl, hashlib, json, os, re, selectors, signal, stat, subprocess, sys, tempfile, time
from pathlib import Path
from .oracle_fleet_config import _check_parent

MAX_INPUT=16*1024; MAX_OUTPUT=16*1024; MAX_PROFILES=40
KINDS={"claude","opencode","hermes"}; MODEL=re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:+/@-]{0,159}$"); ID=re.compile(r"^[A-Za-z0-9_-]{16,48}$")
def revision(raw:bytes)->str:return base64.urlsafe_b64encode(hashlib.sha256(raw).digest()[:18]).decode().rstrip("=")
def _trusted(value):
    if type(value) is not dict or set(value)-KINDS: raise ValueError("trusted_executable_config_invalid")
    result={}
    for kind,paths in value.items():
        if not isinstance(paths,list) or len(paths)>8 or any(not isinstance(p,str) or not os.path.isabs(p) or "\x00" in p for p in paths): raise ValueError("trusted_executable_config_invalid")
        real=[]
        for p in paths:
            try: resolved=str(Path(p).resolve(strict=True))
            except OSError: continue
            if os.path.isfile(resolved) and os.access(resolved,os.X_OK): real.append(resolved)
        result[kind]=sorted(set(real))
    return result
def _validate_profile(value,trusted,*,enforce_trust=True):
    if type(value) is not dict or set(value)!={"id","kind","label","cwd","binary","enabled","allowedModels"}: raise ValueError("invalid_profile")
    if not isinstance(value["id"],str) or not ID.fullmatch(value["id"]) or value["kind"] not in KINDS: raise ValueError("invalid_profile")
    label=value["label"]
    if not isinstance(label,str) or not 1<=len(label)<=80 or label.strip()!=label or any(ord(c)<32 for c in label): raise ValueError("invalid_profile")
    binary=value["binary"]
    if not isinstance(binary,str) or not os.path.isabs(binary) or "\x00" in binary or enforce_trust and binary not in trusted.get(value["kind"],[]): raise ValueError("executable_not_trusted")
    cwd=value["cwd"]
    if not isinstance(cwd,str) or not os.path.isabs(cwd) or "\x00" in cwd: raise ValueError("invalid_working_directory")
    try:
        p=Path(cwd)
        if enforce_trust and (p.is_symlink() or not p.is_dir()): raise ValueError("invalid_working_directory")
        if enforce_trust: cwd=str(p.resolve(strict=True))
    except OSError as exc: raise ValueError("invalid_working_directory") from exc
    models=value["allowedModels"]
    if type(models) is not list or len(models)>100 or any(not isinstance(m,str) or not MODEL.fullmatch(m) for m in models) or len(set(models))!=len(models): raise ValueError("invalid_models")
    if type(value["enabled"]) is not bool: raise ValueError("invalid_profile")
    return {"id":value["id"],"kind":value["kind"],"label":label,"cwd":cwd,"binary":binary,"enabled":value["enabled"],"allowedModels":models}
def _read(path, trusted):
    if path.is_symlink(): raise ValueError("registry_path_invalid")
    try:
        info=path.lstat()
    except FileNotFoundError:return b"",{"version":1,"profiles":[]}
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)&0o077: raise ValueError("registry_permissions_invalid")
    if info.st_size > 64*1024: raise ValueError("registry_too_large")
    fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
    try:
        opened=os.fstat(fd)
        if opened.st_ino!=info.st_ino or opened.st_dev!=info.st_dev or not stat.S_ISREG(opened.st_mode): raise ValueError("registry_path_invalid")
        raw=os.read(fd,64*1024+1)
    finally: os.close(fd)
    if len(raw)>64*1024: raise ValueError("registry_too_large")
    doc=json.loads(raw)
    if type(doc) is not dict or set(doc)!={"version","profiles"} or doc["version"]!=1 or type(doc["profiles"]) is not list or len(doc["profiles"])>MAX_PROFILES: raise ValueError("registry_invalid")
    seen=set()
    for profile in doc["profiles"]:
        if type(profile) is not dict or set(profile)!={"id","kind","label","cwd","binary","enabled","allowedModels","probeState","probeCheck","probeAt","probeOutput"}: raise ValueError("registry_invalid")
        clean={key:profile[key] for key in ("id","kind","label","cwd","binary","enabled","allowedModels")}
        _validate_profile(clean,trusted,enforce_trust=False)
        if clean["binary"] not in trusted.get(clean["kind"],[]):
            profile.update({"probeState":"unavailable","probeCheck":None,"probeAt":None,"probeOutput":"Executable is no longer available in the trusted installation registry."})
        if clean["id"] in seen: raise ValueError("registry_invalid")
        seen.add(clean["id"])
        if profile["probeState"] not in {"unverified","available","unavailable","timeout","output_limited"} or profile["probeCheck"] not in {None,"version","help"} or (profile["probeAt"] is not None and (type(profile["probeAt"]) is not int or profile["probeAt"]<0)) or not isinstance(profile["probeOutput"],str) or len(profile["probeOutput"].encode())>1024: raise ValueError("registry_invalid")
    return raw,doc
def _atomic(path,raw):
    _check_parent(path, create=True)
    if path.parent.is_symlink() or path.parent.stat().st_uid!=os.getuid() or stat.S_IMODE(path.parent.stat().st_mode)&0o077: raise ValueError("registry_permissions_invalid")
    tmp=path.with_name(path.name+f".tmp.{os.getpid()}.{os.urandom(4).hex()}")
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,"wb") as stream: stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.replace(tmp,path)
        dfd=os.open(path.parent,os.O_RDONLY);os.fsync(dfd);os.close(dfd)
    finally:
        try:tmp.unlink()
        except FileNotFoundError:pass
def _probe(profile,check,runner=None):
    if check not in {"version","help"}:raise ValueError("invalid_probe")
    argv=[profile["binary"],"--version" if check=="version" else "--help"]
    if runner:return runner(argv,profile["cwd"],5,MAX_OUTPUT)
    with tempfile.TemporaryDirectory(prefix="rotoxy-runner-probe-") as isolated_home:
        env={"PATH":"/usr/bin:/bin","HOME":isolated_home,"LANG":"C.UTF-8"}
        proc=subprocess.Popen(argv,cwd=profile["cwd"],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=env,shell=False,close_fds=True)
        sel=selectors.DefaultSelector();sel.register(proc.stdout,selectors.EVENT_READ);out=bytearray();deadline=time.monotonic()+5
        try:
            while True:
                remaining=deadline-time.monotonic()
                if remaining<=0:proc.kill();proc.wait();return {"state":"timeout","output":""}
                if proc.poll() is not None and not sel.get_map():break
                for key,_ in sel.select(min(remaining,.1)):
                    chunk=os.read(key.fd,2048)
                    if not chunk:sel.unregister(key.fileobj);continue
                    out.extend(chunk)
                    if len(out)>MAX_OUTPUT:proc.kill();proc.wait();return {"state":"output_limited","output":out[:MAX_OUTPUT].decode("utf-8","replace")}
                if proc.poll() is not None and not sel.get_map():break
            code=proc.wait();text=out.decode("utf-8","replace").strip()
            return {"state":"available" if code==0 else "unavailable","output":text[:500]}
        finally:
            sel.close()
            if proc.poll() is None:proc.kill();proc.wait()
def apply(path:Path,request,trusted_executables,probe_runner=None,now=None):
    trusted=_trusted(trusted_executables)
    if type(request) is not dict or request.get("action") not in {"read","add","update","remove","enable","probe"}:raise ValueError("invalid_request")
    path=Path(path)
    if not path.is_absolute() or "\x00" in str(path):raise ValueError("registry_path_invalid")
    _check_parent(path, create=True)
    lock_path=path.with_name(path.name+".lock")
    if lock_path.is_symlink():raise ValueError("registry_path_invalid")
    lock_fd=os.open(lock_path,os.O_CREAT|os.O_RDWR|getattr(os,"O_NOFOLLOW",0),0o600)
    lock_info=os.fstat(lock_fd)
    if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid!=os.getuid():
        os.close(lock_fd); raise ValueError("registry_path_invalid")
    try:
        os.fchmod(lock_fd,0o600);fcntl.flock(lock_fd,fcntl.LOCK_EX)
        raw,doc=_read(path,trusted);rev=revision(raw);action=request["action"]
        if action=="read":
            if set(request)!={"action"}:raise ValueError("invalid_request")
            return {"revision":rev,"profiles":doc["profiles"],"trustedExecutables":trusted}
        if request.get("revision")!=rev:raise ValueError("revision_conflict")
        if action=="probe":
            if set(request)!={"action","revision","id","check"}:raise ValueError("invalid_request")
            if request["check"] not in {"version","help"}:raise ValueError("invalid_probe")
            stored=next((p for p in doc["profiles"] if p["id"]==request["id"]),None)
            if stored is None:raise ValueError("profile_not_found")
            # Probe only the validated profile fields; registry metadata is never executable input.
            profile=_validate_profile({key:stored[key] for key in ("id","kind","label","cwd","binary","enabled","allowedModels")},trusted)
            result=_probe(profile,request["check"],probe_runner)
            result["output"]=result["output"][:1024]
            stored.update({"probeState":result["state"],"probeCheck":request["check"],"probeAt":int(time.time() if now is None else now),"probeOutput":result["output"]})
        else:
            if set(request)!=( {"action","revision","profile"} if action in {"add","update"} else {"action","revision","id"} if action in {"remove","enable"} else set()):raise ValueError("invalid_request")
            if action in {"add","update"}:
                p=_validate_profile(request["profile"],trusted);profiles=doc["profiles"]
                old=next((x for x in profiles if x["id"]==p["id"]),None)
                if action=="add":
                    if old:raise ValueError("profile_exists")
                    if len(profiles)>=MAX_PROFILES:raise ValueError("profile_limit")
                    p.update({"probeState":"unverified","probeCheck":None,"probeAt":None,"probeOutput":""});profiles.append(p)
                else:
                    if old is None:raise ValueError("profile_not_found")
                    old.update(p);old.update({"probeState":"unverified","probeCheck":None,"probeAt":None,"probeOutput":""})
            else:
                if not isinstance(request.get("id"),str) or not ID.fullmatch(request["id"]):raise ValueError("invalid_request")
                profile=next((p for p in doc["profiles"] if p["id"]==request["id"]),None)
                if profile is None:raise ValueError("profile_not_found")
                if action=="remove":doc["profiles"].remove(profile)
                else:profile["enabled"]=not profile["enabled"]
        # Probe stores only a bounded, non-secret CLI version/help excerpt.
        if action=="probe":
            pass
        encoded=(json.dumps({"version":1,"profiles":doc["profiles"]},ensure_ascii=False,separators=(",",":"))+"\n").encode()
        if len(encoded)>64*1024:raise ValueError("registry_too_large")
        if raw:
            backup=path.with_name(path.name+".backup."+rev)
            if backup.exists():
                if backup.is_symlink() or backup.read_bytes()!=raw:raise ValueError("backup_collision")
            else:_atomic(backup,raw)
        _atomic(path,encoded)
        return {"revision":revision(encoded),"profiles":doc["profiles"],"trustedExecutables":trusted}
    finally:
        fcntl.flock(lock_fd,fcntl.LOCK_UN);os.close(lock_fd)

def main(argv=None):
    parser=argparse.ArgumentParser();parser.add_argument("--config",required=True);args=parser.parse_args(argv)
    try:
        raw=sys.stdin.buffer.read(MAX_INPUT+1)
        if len(raw)>MAX_INPUT:raise ValueError("input_too_large")
        value=json.loads(raw)
        if type(value) is not dict or set(value)!={"request","trustedExecutables"}:raise ValueError("invalid_request")
        result=apply(Path(args.config),value["request"],value["trustedExecutables"])
        print(json.dumps(result,separators=(",",":")));return 0
    except Exception as exc:
        safe={"invalid_request","trusted_executable_config_invalid","invalid_profile","executable_not_trusted","invalid_working_directory","invalid_models","revision_conflict","profile_not_found","profile_exists","profile_limit","invalid_probe","registry_path_invalid","registry_permissions_invalid","registry_invalid","registry_too_large","backup_collision","input_too_large"}
        message=str(exc);print(json.dumps({"error":message if message in safe else "runner_registry_failed"},separators=(",",":")));return 2
if __name__=="__main__":raise SystemExit(main())
