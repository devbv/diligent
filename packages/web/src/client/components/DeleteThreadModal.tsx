// @summary Confirmation modal for permanently deleting a conversation thread
import { Button } from "./Button";
import { Modal } from "./Modal";

interface DeleteThreadModalProps {
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteThreadModal({ onCancel, onConfirm }: DeleteThreadModalProps) {
  return (
    <Modal
      title="Delete conversation?"
      description="This will permanently delete the conversation file. This action cannot be undone."
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className="flex items-center justify-end gap-2">
        <Button intent="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button intent="danger" size="sm" onClick={onConfirm}>
          Delete
        </Button>
      </div>
    </Modal>
  );
}
