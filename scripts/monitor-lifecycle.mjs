/** Keep an orderly service stop distinct from a failed provider observation. */
export function childExitState(stopping,code,signal){
  if(stopping)return 'stopped';
  return code===0&&signal===null?'completed':'failed';
}
