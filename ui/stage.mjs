export const SCENES = Object.freeze(['idle','listening','speaking','headphones','work','critique','golf','away']);

/** Selects a visual mood from actual interaction and goal state. Timed departures require a running task. */
export function sceneFor({mode='ready',goal=null,workingMs=0,completedRecently=false}={}) {
  if(mode==='listening')return 'listening';
  if(mode==='speaking')return 'speaking';
  if(mode==='setup' || mode==='review')return 'critique';
  if(!goal)return 'idle';
  if(completedRecently || goal.status==='completed')return 'critique';
  if(goal.status==='queued')return 'headphones';
  if(goal.status==='running') {
    const active=Array.isArray(goal.tasks) && goal.tasks.some(task=>task.status==='running');
    if(!active)return 'work';
    if(workingMs>=14000)return 'away';
    if(workingMs>=8000)return 'golf';
    return 'work';
  }
  return 'idle';
}

