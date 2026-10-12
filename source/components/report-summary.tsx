'use client';

import { Clock3, FolderKanban, ListChecks, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { duration, formatDuration, type Session } from '@/lib/time';

export function ReportSummary({ sessions, projects, period, onConnect }: {
  sessions: Session[];
  projects: {id: string; name: string}[];
  period: string;
  onConnect: () => void;
}) {
  const total = duration(sessions);
  const activePeople = new Set(sessions.map(s => s.person_id)).size;
  const allocation = projects.map(project => ({
    ...project,
    milliseconds: duration(sessions.filter(s => s.project_id === project.id)),
  })).filter(project => project.milliseconds > 0).sort((a, b) => b.milliseconds - a.milliseconds);
  const periodName = ({day:'За день',week:'За неделю',month:'За месяц',year:'За год'} as Record<string,string>)[period];

  return <div className="report-summary-grid">
    <section className="total-panel" aria-label="Итог времени">
      <div className="total-panel-top"><span className="eyebrow">УЧТЁННОЕ ВРЕМЯ</span><span className="period-label"><span className="subtle-dot" aria-hidden="true"/>{periodName}</span></div>
      <div className="total-number">{formatDuration(total)}</div>
      <p className="total-description">{sessions.length ? 'Время команды за выбранный период' : 'Сессии появятся после подключения устройства'}</p>
      <div className="total-details">
        <div><ListChecks size={17}/><span><strong>{sessions.length}</strong><small>Интервалов</small></span></div>
        <div><Users size={17}/><span><strong>{activePeople}</strong><small>Сотрудников с активностью</small></span></div>
      </div>
    </section>
    <section className="project-summary" aria-label="Распределение времени по проектам">
      <div className="section-head"><h2>По проектам</h2><FolderKanban size={18}/></div>
      {allocation.length ? <div className="allocation-list">{allocation.map((project, index) => <div className="project-bar" key={project.id}>
        <div className="project-bar-label"><span><i className={'project-dot tone-'+index%4}/>{project.name}</span><strong>{formatDuration(project.milliseconds)}</strong></div>
        <div className="bar-track" aria-hidden="true"><span className={'tone-'+index%4} style={{width:`${total ? project.milliseconds/total*100 : 0}%`}}/></div>
        <small className="project-share">{total ? Math.round(project.milliseconds/total*100) : 0}% учтённого времени</small>
      </div>)}</div> : <div className="empty compact"><Clock3 size={25}/><h3>Начните отсчёт</h3><p>Подключите компьютер, чтобы видеть время по проектам.</p><Button variant="outline" onClick={onConnect}>Подключить устройство</Button></div>}
    </section>
  </div>;
}
