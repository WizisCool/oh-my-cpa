import { useLocation, useNavigate } from 'react-router-dom';
import { consolePageOf, useDeclaredPageContext } from '../../agent/pageContext';
import { AgentWorkspace } from '../../pages/agent/AgentPage';

/**
 * The Agent workspace docked beside whatever page is open (ADR 0073). It adds only what the dock
 * knows and the workspace does not: which page that is, and what the page declared about itself.
 */
export default function AssistantDock({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const declared = useDeclaredPageContext();
  const page = consolePageOf(location.pathname);
  return (
    <AgentWorkspace
      variant="dock"
      pageContext={page ? { page, ...declared } : undefined}
      isActive={isOpen}
      onClose={onClose}
      onExpand={() => {
        onClose();
        navigate('/agent');
      }}
    />
  );
}
