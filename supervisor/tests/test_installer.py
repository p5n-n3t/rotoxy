import subprocess
import tempfile
import unittest
from pathlib import Path


class InstallerTests(unittest.TestCase):
    installer = Path(__file__).resolve().parents[1] / 'install.sh'
    def run_installer(self,*args):
        return subprocess.run(['bash',str(self.installer),*args],capture_output=True,text=True,timeout=5)

    def test_help_and_shell_syntax(self):
        self.assertEqual(subprocess.run(['bash','-n',str(self.installer)]).returncode,0)
        result=self.run_installer('--help')
        self.assertEqual(result.returncode,0);self.assertIn('--state',result.stdout)

    def test_unsafe_or_ambiguous_install_arguments_reject_before_install(self):
        for args in (['--not-an-option'],['--repo','/example'],['--state','relative']):
            self.assertNotEqual(self.run_installer(*args).returncode,0)
        with tempfile.TemporaryDirectory() as root:
            marker=Path(root)/'snooze';marker.write_text('unrelated existing launcher')
            self.assertNotEqual(self.run_installer('--bin-dir',root).returncode,0)
            self.assertEqual(marker.read_text(),'unrelated existing launcher')
